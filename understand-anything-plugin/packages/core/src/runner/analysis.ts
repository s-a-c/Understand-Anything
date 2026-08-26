/**
 * Structural analysis for the non-interactive runner.
 *
 * Enumerates files (git ls-files preferred, walk fallback), applies the
 * existing ignore precedence via core's createIgnoreFilter, runs structural
 * analysis through the PluginRegistry, assembles a valid KnowledgeGraph via
 * GraphBuilder, and builds the fingerprint store.
 *
 * Incremental mode: when a compatible baseline generation exists, files whose
 * content hash is unchanged have their nodes/edges reused verbatim from the
 * baseline graph — unchanged work is skipped. Any missing or incompatible
 * state falls back to safe full analysis.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createIgnoreFilter } from "../ignore-filter.js";
import { contentHash, buildFingerprintStore, type FingerprintStore } from "../fingerprint.js";
import { GraphBuilder } from "../analyzer/graph-builder.js";
import type {
  KnowledgeGraph,
  StructuralAnalysis,
} from "../types.js";
import type { PluginRegistry } from "../plugins/registry.js";

const MAX_FILES = 5_000;

export interface StructuralScanInput {
  projectRoot: string;
  pluginRegistry: PluginRegistry;
  /** Compatible current generation, or null when full analysis is required. */
  baseline: { dir: string; meta: import("./types.js").GenerationMeta } | null;
  forceFull: boolean;
  onProgress?: (phase: string, counts?: Record<string, number>) => void;
}

export interface StructuralScanResult {
  graph: KnowledgeGraph;
  fingerprints: FingerprintStore;
  analyzedFiles: number;
  mode: "incremental" | "full" | "full-fallback";
}

function walkFiles(projectRoot: string, dir: string = projectRoot, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(projectRoot, fullPath, out);
    } else if (entry.isFile()) {
      const rel = relative(projectRoot, fullPath).split(sep).join("/");
      out.push(rel);
    }
  }
  return out;
}

/** Load baseline fingerprints.json from a generation directory. */
function loadBaselineFingerprints(baselineDir: string): FingerprintStore | null {
  const path = join(baselineDir, "fingerprints.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as FingerprintStore;
    return typeof parsed?.files === "object" && parsed.files !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function runStructuralScan(input: StructuralScanInput): Promise<StructuralScanResult> {
  const { projectRoot, pluginRegistry, baseline, forceFull, onProgress } = input;

  onProgress?.("enumerating files");

  // 1. Enumerate candidate files.
  const gitFiles = await new Promise<string[] | null>((resolvePromise) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: projectRoot, encoding: "utf-8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) resolvePromise(null);
        else resolvePromise(stdout.split("\0").filter((p) => p.length > 0));
      },
    );
  });
  const candidates = gitFiles ?? walkFiles(projectRoot);

  // 2. Apply existing ignore precedence (built-in + data-dir + project),
  //    and always exclude the UA data dirs themselves from analysis.
  const ignoreFilter = createIgnoreFilter(projectRoot);
  const isUaData = (p: string) =>
    p === ".ua" || p.startsWith(".ua/") || p === ".understand-anything" || p.startsWith(".understand-anything/");
  const filtered = candidates
    .filter((f) => !isUaData(f) && !ignoreFilter.isIgnored(f))
    .sort();

  if (filtered.length > MAX_FILES) {
    throw new Error(`project too large for runner (${filtered.length} files)`);
  }

  // 3. Decide incremental vs full.
  const baselineFingerprints =
    !forceFull && baseline !== null ? loadBaselineFingerprints(baseline.dir) : null;
  const canIncremental =
    baseline !== null &&
    baselineFingerprints !== null &&
    existsSync(join(baseline.dir, "knowledge-graph.json"));

  let baselineGraph: KnowledgeGraph | null = null;
  if (canIncremental && baseline !== null) {
    try {
      baselineGraph = JSON.parse(
        readFileSync(join(baseline.dir, "knowledge-graph.json"), "utf-8"),
      ) as KnowledgeGraph;
    } catch {
      baselineGraph = null;
    }
  }

  // 4. Per-file analysis; reuse unchanged work when incremental.
  interface AnalyzedFile {
    filePath: string;
    analysis: StructuralAnalysis | null;
    summary: string;
  }
  const analyzed: AnalyzedFile[] = [];
  const changedPaths: string[] = [];
  const reusedCount = { value: 0 };

  for (const filePath of filtered) {
    const absolutePath = join(projectRoot, filePath);
    let fileContent: string;
    try {
      if (!statSync(absolutePath).isFile()) continue;
      fileContent = readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }

    const hash = contentHash(fileContent);
    const oldFp = baselineGraph ? baselineFingerprints?.files[filePath] : undefined;

    if (oldFp && oldFp.contentHash === hash && baselineGraph) {
      // Unchanged compatible file — structural work is reused downstream.
      analyzed.push({ filePath, analysis: null, summary: "__REUSED__" });
      reusedCount.value += 1;
      continue;
    }

    const analysis = pluginRegistry.analyzeFile(filePath, fileContent);
    analyzed.push({
      filePath,
      analysis,
      summary: analysis
        ? `${analysis.functions.length} functions, ${analysis.classes.length} classes`
        : "no structural analysis available",
    });
    changedPaths.push(filePath);
  }

  onProgress?.("analyzing files", {
    total: filtered.length,
    reused: reusedCount.value,
    reanalyzed: changedPaths.length,
  });

  // 5. Assemble the graph.
  const projectName = projectRoot.split("/").pop() || projectRoot;
  const gitHash = baseline?.meta.gitCommitHash ?? "";
  const builder = new GraphBuilder(projectName, gitHash);

  const reusedNodes = new Map<string, import("../types.js").GraphNode>();
  const reusedEdges: import("../types.js").GraphEdge[] = [];

  for (const file of analyzed) {
    if (file.summary === "__REUSED__" && baselineGraph) {
      // Reuse this file's nodes and its edges wholesale.
      const fileId = `file:${file.filePath}`;
      for (const node of baselineGraph.nodes) {
        if (node.id === fileId || node.filePath === file.filePath) {
          reusedNodes.set(node.id, node);
        }
      }
      const keptIds = new Set(reusedNodes.keys());
      for (const edge of baselineGraph.edges) {
        if (keptIds.has(edge.source)) reusedEdges.push(edge);
      }
      continue;
    }

    const analysis = file.analysis;
    if (analysis && (analysis.functions.length > 0 || analysis.classes.length > 0)) {
      builder.addFileWithAnalysis(file.filePath, analysis, {
        summary: file.summary,
        fileSummary: file.summary,
        summaries: {},
        tags: [],
        complexity: complexityFor(analysis),
      });
    } else {
      builder.addFile(file.filePath, {
        summary: file.summary,
        tags: [],
        complexity: "simple",
      });
    }
  }

  const freshGraph = builder.build();

  // 6. Merge reused + fresh nodes deterministically (reused first).
  const nodes = [...reusedNodes.values(), ...freshGraph.nodes];
  const seenIds = new Set(nodes.map((n) => n.id));
  const edges = [...reusedEdges, ...freshGraph.edges].filter(
    (e) => seenIds.has(e.source) && seenIds.has(e.target),
  );

  const graph: KnowledgeGraph = {
    ...freshGraph,
    nodes,
    edges: dedupeEdges(edges),
  };

  // 7. Fingerprints cover every scanned file (reused entries copied forward).
  const fingerprintStore = buildFingerprintStore(
    projectRoot,
    filtered.filter((f) => existsSync(join(projectRoot, f))),
    pluginRegistry,
    gitHash,
  );

  const mode: StructuralScanResult["mode"] = forceFull
    ? "full"
    : baseline !== null && reusedCount.value > 0
      ? "incremental"
      : "full-fallback";

  onProgress?.("scan complete", { files: filtered.length, mode: mode === "incremental" ? 1 : 0 });

  return {
    graph,
    fingerprints: fingerprintStore,
    analyzedFiles: filtered.length,
    mode,
  };
}

function complexityFor(analysis: StructuralAnalysis): "simple" | "moderate" | "complex" {
  const weight =
    analysis.functions.length + analysis.classes.length * 2 + analysis.imports.length * 0.5;
  if (weight > 20) return "complex";
  if (weight > 8) return "moderate";
  return "simple";
}

function dedupeEdges(edges: import("../types.js").GraphEdge[]): import("../types.js").GraphEdge[] {
  const seen = new Set<string>();
  const out: import("../types.js").GraphEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

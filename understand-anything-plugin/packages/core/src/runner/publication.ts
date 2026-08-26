/**
 * Generation publication.
 *
 * A generation is an immutable directory under `<uaDir>/generations/<id>/`
 * containing knowledge-graph.json, fingerprints.json, and generation.json
 * (the validated metadata + manifest). Publication atomically replaces
 * `<uaDir>/current.json` via write-temp-then-rename. Failure paths remove
 * only staged output and leave the prior pointer untouched. Existing flat
 * data (knowledge-graph.json at the uaDir root) remains a read-only baseline.
 */

import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validateGraph } from "../schema.js";
import type { KnowledgeGraph } from "../types.js";
import { RUNNER_VERSION } from "./types.js";
import type { CurrentPointer, Generation, GenerationManifest, GenerationMeta } from "./types.js";

export function resolveUaDirForGenerations(projectRoot: string): string {
  const legacy = join(projectRoot, ".understand-anything");
  return existsSync(legacy) ? legacy : join(projectRoot, ".ua");
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface StageInput {
  projectRoot: string;
  projectId: string;
  graph: KnowledgeGraph;
  fingerprintsJson: string;
  metaBase: Omit<GenerationMeta, "manifest">;
}

export interface StagedGeneration {
  dir: string;
  uaDir: string;
  generationId: string;
  manifest: GenerationManifest;
  metaJson: string;
}

/** Validate the graph and stage all generation files into a temp directory. */
export function stageGeneration(input: StageInput): StagedGeneration {
  const uaDir = resolveUaDirForGenerations(input.projectRoot);
  const generationsDir = join(uaDir, "generations");

  // Validate the graph before anything touches disk.
  const result = validateGraph(JSON.parse(JSON.stringify(input.graph)));
  if (!result.success) {
    throw new Error(`graph validation failed`);
  }

  const graphJson = JSON.stringify(input.graph, null, 2);
  const manifest: GenerationManifest = {
    graphHash: sha256(graphJson),
    fingerprintsHash: sha256(input.fingerprintsJson),
    publishedAt: new Date().toISOString(),
    runnerVersion: RUNNER_VERSION,
  };
  const meta: GenerationMeta = { ...input.metaBase, manifest };
  const metaJson = JSON.stringify(meta, null, 2);

  const generationId = `${meta.analyzedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const dir = join(generationsDir, generationId);
  const tmpDir = join(generationsDir, `.tmp-${generationId}`);

  mkdirSync(tmpDir, { recursive: true });
  try {
    writeFileSync(join(tmpDir, "knowledge-graph.json"), graphJson, "utf-8");
    writeFileSync(join(tmpDir, "fingerprints.json"), input.fingerprintsJson, "utf-8");
    writeFileSync(join(tmpDir, "generation.json"), metaJson, "utf-8");
    renameSync(tmpDir, dir);
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }

  return { dir, uaDir, generationId, manifest, metaJson };
}

/**
 * Atomically point `current.json` at a staged generation.
 * Temp-write then rename; readers either see the old or the new pointer.
 */
export function publishStaged(staged: StagedGeneration): Generation {
  const pointerPath = join(staged.uaDir, "current.json");
  const pointer: CurrentPointer = {
    generation: staged.generationId,
    updatedAt: new Date().toISOString(),
  };
  const tmpPointer = join(staged.uaDir, `.current-${process.pid}-${Date.now()}.json.tmp`);
  writeFileSync(tmpPointer, JSON.stringify(pointer, null, 2), "utf-8");
  renameSync(tmpPointer, pointerPath);

  return {
    dir: staged.dir,
    meta: JSON.parse(
      readFileSync(join(staged.dir, "generation.json"), "utf-8"),
    ) as GenerationMeta,
  };
}

/** Remove a staged generation after failure/cancel. Prior pointer is untouched. */
export function discardStaged(staged: Pick<StagedGeneration, "dir">): void {
  rmSync(staged.dir, { recursive: true, force: true });
}

export interface ReadCurrentResult {
  generation: Generation;
  pointer: CurrentPointer;
}

/**
 * Resolve the current published generation for a project, or null when none
 * has been published yet. Legacy flat layouts are intentionally NOT returned:
 * they are a read-only baseline, never an incremental baseline.
 */
export function readCurrent(projectRoot: string): ReadCurrentResult | null {
  const uaDir = resolveUaDirForGenerations(projectRoot);
  const pointerPath = join(uaDir, "current.json");
  if (!existsSync(pointerPath)) return null;

  let pointer: CurrentPointer;
  try {
    pointer = JSON.parse(readFileSync(pointerPath, "utf-8")) as CurrentPointer;
  } catch {
    return null;
  }
  if (typeof pointer?.generation !== "string" || pointer.generation.length === 0) return null;

  const dir = join(uaDir, "generations", pointer.generation);
  const metaPath = join(dir, "generation.json");
  if (!existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as GenerationMeta;
    return { generation: { dir, meta }, pointer };
  } catch {
    return null;
  }
}

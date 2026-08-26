import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stageGeneration,
  publishStaged,
  discardStaged,
  readCurrent,
} from "../publication.js";
import type { GenerationMeta, PreAnalysisSnapshot } from "../types.js";

function makeGraphProject(): { root: string; uaDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ua-pub-"));
  const uaDir = join(root, ".ua");
  mkdirSync(uaDir, { recursive: true });
  return { root, uaDir };
}

const preAnalysis: PreAnalysisSnapshot = {
  headCommitHash: "a".repeat(40),
  workingTreeDirty: false,
  dirtyContentDigest: "0".repeat(64),
  capturedAt: "2026-01-01T00:00:00.000Z",
};

function graphFixture() {
  return {
    version: "1.0.0",
    project: {
      name: "fixture",
      languages: ["typescript"],
      frameworks: [],
      description: "fixture project",
      analyzedAt: "2026-01-01T00:00:00.000Z",
      gitCommitHash: preAnalysis.headCommitHash,
    },
    nodes: [
      {
        id: "file:src/index.ts",
        type: "file",
        name: "index.ts",
        filePath: "src/index.ts",
        summary: "entry",
        tags: [],
        complexity: "simple",
      },
    ],
    edges: [],
    layers: [],
    tour: [],
  };
}

function metaBase(projectId = "proj"): Omit<GenerationMeta, "manifest"> {
  return {
    projectId,
    gitCommitHash: preAnalysis.headCommitHash,
    analyzedAt: new Date().toISOString(),
    analyzedFiles: 1,
    ignoreDigest: "f".repeat(64),
    providerProfileId: "operator/model-x",
    preAnalysis,
    workingTreeDirty: false,
  };
}

let project: { root: string; uaDir: string };

beforeEach(() => {
  project = makeGraphProject();
});

describe("stageGeneration", () => {
  it("stages a validated generation directory with all three files", () => {
    const staged = stageGeneration({
      projectRoot: project.root,
      projectId: "proj",
      graph: graphFixture() as never,
      fingerprintsJson: "{}",
      metaBase: metaBase(),
    });
    expect(existsSync(join(staged.dir, "knowledge-graph.json"))).toBe(true);
    expect(existsSync(join(staged.dir, "fingerprints.json"))).toBe(true);
    expect(existsSync(join(staged.dir, "generation.json"))).toBe(true);
    expect(staged.manifest.runnerVersion).toBe("1.0.0");
  });

  it("rejects an invalid graph and leaves no staged output", () => {
    const bad = { ...graphFixture(), nodes: [{ id: 42 }] };
    expect(() =>
      stageGeneration({
        projectRoot: project.root,
        projectId: "proj",
        graph: bad as never,
        fingerprintsJson: "{}",
        metaBase: metaBase(),
      }),
    ).toThrow(/validation failed/);
  });

  it("records only redacted profile identifiers in generation metadata", () => {
    const staged = stageGeneration({
      projectRoot: project.root,
      projectId: "proj",
      graph: graphFixture() as never,
      fingerprintsJson: "{}",
      metaBase: metaBase(),
    });
    const meta = JSON.parse(readFileSync(join(staged.dir, "generation.json"), "utf-8")) as GenerationMeta;
    expect(meta.providerProfileId).toBe("operator/model-x");
    expect(JSON.stringify(meta)).not.toMatch(/endpoint|api[_-]?key|secret/i);
  });
});

describe("publishStaged + readCurrent", () => {
  it("atomically points current.json at the staged generation", () => {
    const staged = stageGeneration({
      projectRoot: project.root,
      projectId: "proj",
      graph: graphFixture() as never,
      fingerprintsJson: "{}",
      metaBase: metaBase(),
    });
    const generation = publishStaged(staged);

    const pointerPath = join(project.uaDir, "current.json");
    expect(existsSync(pointerPath)).toBe(true);
    const pointer = JSON.parse(readFileSync(pointerPath, "utf-8"));
    expect(pointer.generation).toBe(staged.generationId);

    const current = readCurrent(project.root);
    expect(current).not.toBeNull();
    expect(current!.generation.meta.projectId).toBe("proj");
    expect(current!.generation.meta.manifest.graphHash).toBe(
      generation.meta.manifest.graphHash,
    );
    // No temp pointer files left behind.
    const leftovers = execFileSync("ls", [project.uaDir]).toString().match(/current.*tmp/);
    expect(leftovers).toBeNull();
  });

  it("replaces the pointer on re-publication without duplicating directories", () => {
    const commonMeta = metaBase();
    for (const label of ["first", "second"]) {
      const staged = stageGeneration({
        projectRoot: project.root,
        projectId: "proj",
        graph: graphFixture() as never,
        fingerprintsJson: JSON.stringify({ label }),
        metaBase: commonMeta,
      });
      publishStaged(staged);
    }
    const current = readCurrent(project.root)!;
    expect(current.pointer.updatedAt).toBeTruthy();
    const generations = execFileSync("ls", [join(project.uaDir, "generations")]).toString().trim().split("\n");
    expect(generations.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null when nothing has been published", () => {
    expect(readCurrent(project.root)).toBeNull();
  });

  it("returns null for a corrupt pointer instead of throwing", () => {
    writeFileSync(join(project.uaDir, "current.json"), "{corrupt");
    expect(readCurrent(project.root)).toBeNull();
  });

  it("returns null when the pointed generation is missing", () => {
    writeFileSync(join(project.uaDir, "current.json"), JSON.stringify({ generation: "ghost", updatedAt: "x" }));
    expect(readCurrent(project.root)).toBeNull();
  });

  it("treats legacy flat data as invisible to readCurrent", () => {
    writeFileSync(join(project.uaDir, "knowledge-graph.json"), JSON.stringify(graphFixture()));
    writeFileSync(join(project.uaDir, "meta.json"), "{}");
    expect(readCurrent(project.root)).toBeNull();
    // Legacy files untouched by runner publication paths.
    expect(existsSync(join(project.uaDir, "meta.json"))).toBe(true);
  });
});

describe("discardStaged", () => {
  it("removes only the staged directory", () => {
    const staged = stageGeneration({
      projectRoot: project.root,
      projectId: "proj",
      graph: graphFixture() as never,
      fingerprintsJson: "{}",
      metaBase: metaBase(),
    });
    discardStaged(staged);
    expect(existsSync(staged.dir)).toBe(false);
    expect(existsSync(join(project.uaDir, "current.json"))).toBe(false);
  });
});

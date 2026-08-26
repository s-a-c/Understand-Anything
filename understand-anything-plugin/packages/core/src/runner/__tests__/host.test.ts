import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Record every execFile invocation across this file; pass through to real git.
const processRecorder = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  const wrappedExecFile = ((cmd: string, args: string[], ...rest: unknown[]) => {
    processRecorder.calls.push({ cmd, args });
    return (actual.execFile as (...callArgs: unknown[]) => unknown)(
      cmd,
      args,
      ...rest,
    );
  }) as typeof actual.execFile;
  return { ...actual, execFile: wrappedExecFile };
});

// Partially mock snapshot capture so stability tests can force movement.
const snapshotHolder = vi.hoisted(() => ({
  real: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock("../snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../snapshot.js")>();
  snapshotHolder.real =
    actual.capturePreAnalysisSnapshot as unknown as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    capturePreAnalysisSnapshot: vi.fn(),
  };
});

import { capturePreAnalysisSnapshot } from "../snapshot.js";
import { runProject, validateProviderProfile, redactedProfileId } from "../host.js";
import type { RunnerEvent, ProviderProfile, ProjectRegistry } from "../types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { StructuralAnalysis } from "../../types.js";

const mockedCapture = vi.mocked(capturePreAnalysisSnapshot);

function makeGitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ua-host-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf-8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return root;
}

/** Fake analyzer registry: deterministic structural analysis, no tree-sitter. */
function fakePluginRegistry(): PluginRegistry {
  const analysisFor = (filePath: string): StructuralAnalysis => ({
    functions: [
      { name: `fn_${filePath.replace(/\W/g, "_")}`, lineRange: [1, 2], params: [] },
    ],
    classes: [],
    imports: [],
    exports: [{ name: `fn_${filePath.replace(/\W/g, "_")}`, lineNumber: 1 }],
  });
  const registry = {
    analyzeFile: (_filePath: string, _content: string) => analysisFor(_filePath),
    register: () => {},
    unregister: () => {},
    getPluginForLanguage: () => null,
  } as unknown as PluginRegistry;
  return registry;
}

const profile: ProviderProfile = {
  provider: "operator",
  model: "model-x",
  endpoint: "http://127.0.0.1:9999",
  concurrency: 1,
  budget: 1000,
};

const registryFor = (root: string): ProjectRegistry => [
  { id: "fixture", root, name: "Fixture" },
];

interface Harness {
  root: string;
  events: RunnerEvent[];
  run: (overrides?: Partial<Parameters<typeof runProject>[0]>) => Promise<Awaited<ReturnType<typeof runProject>>>;
}

function harness(repoFiles?: Record<string, string>): Harness {
  const root = makeGitRepo(repoFiles ?? { "src/index.ts": "export const x = 1;\n" });
  const events: RunnerEvent[] = [];
  const base = {
    projectId: "fixture",
    registry: registryFor(root),
    profile,
    emit: (event: RunnerEvent) => events.push(event),
  };
  const deps = { buildRegistry: () => Promise.resolve(fakePluginRegistry()) };
  return {
    root,
    events,
    run: (overrides) => runProject({ ...base, ...overrides }, deps),
  };
}

beforeEach(() => {
  mockedCapture.mockImplementation(
    (...args: unknown[]) =>
      snapshotHolder.real!(...(args as Parameters<typeof capturePreAnalysisSnapshot>)) as never,
  );
});
describe("runProject — contract enforcement", () => {
  it("fails fast on an unknown project id without touching disk work", async () => {
    const h = harness();
    const result = await h.run({ projectId: "not-in-registry" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown project id/i);
    expect(h.events.some((e) => e.phase === "error")).toBe(true);
  });

  it("rejects arbitrary paths passed as project ids", async () => {
    const h = harness();
    const result = await h.run({ projectId: "/etc/passwd" });
    expect(result.ok).toBe(false);
  });

  it("validates the provider profile before analysis", () => {
    expect(validateProviderProfile({ ...profile, provider: "" })).toContain("provider missing");
    expect(validateProviderProfile({ ...profile, endpoint: "not-a-url" })).toContain(
      "endpoint must be an http(s) URL",
    );
    expect(validateProviderProfile({ ...profile, concurrency: 0 })).toContain("concurrency must be >= 1");
    expect(validateProviderProfile(profile)).toEqual([]);
  });

  it("records only redacted provider identifiers", () => {
    expect(redactedProfileId(profile)).toBe("operator/model-x");
  });

  it("fails when the project root is not a git repository", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "ua-nogit-"));
    writeFileSync(join(plainDir, "a.ts"), "export {};");
    const h = harness();
    const result = await h.run({ registry: registryFor(plainDir) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/git snapshot/i);
  });
});

describe("runProject — publication pipeline", () => {
  it("runs a full analysis and publishes behind current.json", async () => {
    const h = harness();
    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(result.generation).toBeDefined();
    expect(existsSync(join(h.root, ".ua", "current.json"))).toBe(true);

    const phases = h.events.map((e) => e.phase);
    expect(phases[0]).toBe("start");
    expect(phases).toContain("snapshot");
    expect(phases).toContain("ignore-digest");
    expect(phases).toContain("incremental-check");
    expect(phases).toContain("staging");
    expect(phases).toContain("stability-check");
    expect(phases.at(-1)).toBe("complete");

    const terminal = h.events.at(-1)!;
    expect(terminal.outcome).toBe("ok");

    const meta = JSON.parse(
      readFileSync(join(result.generation!.dir, "generation.json"), "utf-8"),
    );
    expect(meta.projectId).toBe("fixture");
    expect(meta.ignoreDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.providerProfileId).toBe("operator/model-x");
  });

  it("publishes stable dirty content with an explicit warning flag", async () => {
    const h = harness({
      "src/index.ts": "export const x = 1;\n",
      "notes.txt": "scratch",
    });
    // Leave notes.txt untracked -> dirty tree, but stable across the run.
    writeFileSync(join(h.root, "notes2.txt"), "more scratch");

    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(result.generation!.meta.workingTreeDirty).toBe(true);
    expect(result.generation!.meta.preAnalysis.workingTreeDirty).toBe(true);

    const terminal = h.events.find((e) => e.phase === "complete")!;
    expect(terminal.counts?.workingTreeDirty).toBe(1);
  });

  it("never counts runner-written .ua state as dirty content", async () => {
    const h = harness();
    // First run creates .ua/; second run must still see a clean tree.
    await h.run();
    const second = await h.run();
    expect(second.ok).toBe(true);
    expect(second.generation!.meta.workingTreeDirty).toBe(false);

    // The generation must not contain UA-data files as scanned nodes.
    const graph = JSON.parse(
      readFileSync(join(second.generation!.dir, "knowledge-graph.json"), "utf-8"),
    );
    const uaNodes = graph.nodes.filter(
      (n: { filePath?: string }) =>
        n.filePath === ".ua" || (n.filePath ?? "").startsWith(".ua/"),
    );
    expect(uaNodes).toHaveLength(0);
  });

  it("blocks publication and preserves prior generation when HEAD moves mid-run", async () => {
    const h = harness();

    // First publish establishes a baseline generation.
    const first = await h.run();
    expect(first.ok).toBe(true);
    const firstPointer = readFileSync(join(h.root, ".ua", "current.json"), "utf-8");

    // Force the post-analysis capture to observe a different HEAD.
    const realCapture = mockedCapture.getMockImplementation()!;
    let call = 0;
    mockedCapture.mockImplementation(async (...args) => {
      const snap = await realCapture(...args);
      call += 1;
      if (call >= 2) {
        return { ...snap, headCommitHash: "f".repeat(40) };
      }
      return snap;
    });

    const second = await h.run({ forceFull: true });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/inputs moved/i);

    // Prior pointer untouched; no orphan staged dirs remain.
    expect(readFileSync(join(h.root, ".ua", "current.json"), "utf-8")).toBe(firstPointer);
    const generationsRoot = join(h.root, ".ua", "generations");
    if (existsSync(generationsRoot)) {
      const leftovers = execFileSync("ls", [generationsRoot]).toString().trim().split("\n").filter(Boolean);
      expect(leftovers.length).toBe(1); // only the first generation remains
    }
  });

  it("performs incremental reuse on a compatible re-run and still publishes", async () => {
    const h = harness();
    const first = await h.run();
    expect(first.ok).toBe(true);

    const second = await h.run();
    expect(second.ok).toBe(true);

    const checkEvents = h.events.filter((e) => e.phase === "incremental-check");
    expect(checkEvents.length).toBeGreaterThanOrEqual(2);
    expect(checkEvents.at(-1)!.counts?.incremental).toBe(1);
  });

  it("falls back to full analysis after ignore-policy changes", async () => {
    const h = harness();
    const first = await h.run();
    expect(first.ok).toBe(true);
    const firstDigest = first.generation!.meta.ignoreDigest;

    writeFileSync(join(h.root, ".ua", ".understandignore"), "*.txt\n");
    const second = await h.run();
    expect(second.ok).toBe(true);

    const checkEvents = h.events.filter((e) => e.phase === "incremental-check");
    expect(checkEvents.at(-1)!.counts?.incremental).toBe(0);
    expect(second.generation!.meta.ignoreDigest).not.toBe(firstDigest);
  });
});

describe("runProject — host safety", () => {
  it("never spawns a dashboard or shell during a run", async () => {
    processRecorder.calls.length = 0;
    const h = harness();
    const result = await h.run();
    expect(result.ok).toBe(true);

    expect(processRecorder.calls.length).toBeGreaterThan(0);
    for (const call of processRecorder.calls) {
      expect(["git"]).toContain(call.cmd);
      expect(call.args[0]).not.toMatch(/^open$|^osascript$/);
    }
  });

  it("emits only schema-valid events", async () => {
    const { parseRunnerEvent } = await import("../events.js");
    const h = harness();
    await h.run();
    for (const event of h.events) {
      expect(parseRunnerEvent(JSON.stringify(event))).toEqual(event);
    }
  });
});

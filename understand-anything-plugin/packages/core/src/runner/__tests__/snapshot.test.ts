import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { capturePreAnalysisSnapshot, compareSnapshots } from "../snapshot.js";
import type { PreAnalysisSnapshot } from "../types.js";

const mockedExecFile = vi.mocked(execFile);

/** Queue stdout results per invocation; Error entries simulate failure. */
function queueGit(results: Array<string | Error>) {
  let call = 0;
  mockedExecFile.mockImplementation(((...callArgs: unknown[]) => {
    const callback = callArgs[3] as (error: Error | null, stdout: string) => void;
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    if (result instanceof Error) callback(result, "");
    else callback(null, result ?? "");
    return undefined as never;
  }) as never);
}

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("capturePreAnalysisSnapshot", () => {
  it("captures HEAD and a clean tree", async () => {
    queueGit([HEAD_A, "", "", ""]);
    const snap = await capturePreAnalysisSnapshot("/repo");
    expect(snap.headCommitHash).toBe(HEAD_A);
    expect(snap.workingTreeDirty).toBe(false);
    expect(snap.dirtyContentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks the tree dirty when files are modified", async () => {
    queueGit([HEAD_A, "src/a.ts\0", "", ""]);
    const snap = await capturePreAnalysisSnapshot("/repo");
    expect(snap.workingTreeDirty).toBe(true);
  });

  it("treats staged and untracked files as dirty state", async () => {
    queueGit([HEAD_A, "", "staged.ts\0", "untracked.ts\0"]);
    const snap = await capturePreAnalysisSnapshot("/repo");
    expect(snap.workingTreeDirty).toBe(true);
  });

  it("throws when git fails (not a repository)", async () => {
    queueGit([new Error("fatal: not a git repository")]);
    await expect(capturePreAnalysisSnapshot("/repo")).rejects.toThrow();
  });

  it("passes UA-data pathspec excludes to every dirty query", async () => {
    queueGit([HEAD_A, "", "", ""]);
    await capturePreAnalysisSnapshot("/repo");
    for (let i = 1; i <= 3; i += 1) {
      const args = mockedExecFile.mock.calls[i]?.[1] as string[] | undefined;
      expect(args).toContain(":(exclude).ua");
      expect(args).toContain(":(exclude).ua/**");
      expect(args).toContain(":(exclude).understand-anything");
      expect(args).toContain(":(exclude).understand-anything/**");
    }
  });
});

function snap(overrides?: Partial<PreAnalysisSnapshot>): PreAnalysisSnapshot {
  return {
    headCommitHash: HEAD_A,
    workingTreeDirty: false,
    dirtyContentDigest: "d1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("compareSnapshots", () => {
  it("accepts identical snapshots", () => {
    expect(compareSnapshots(snap(), snap())).toEqual({ stable: true });
  });

  it("blocks publication when HEAD moves", () => {
    const result = compareSnapshots(snap(), snap({ headCommitHash: HEAD_B }));
    expect(result.stable).toBe(false);
    expect(result.reason).toBe("head_moved");
  });

  it("blocks when dirty state appears or disappears", () => {
    const becameClean = compareSnapshots(snap({ workingTreeDirty: true }), snap());
    const becameDirty = compareSnapshots(snap(), snap({ workingTreeDirty: true }));
    expect(becameClean.reason).toBe("dirty_state_changed");
    expect(becameDirty.reason).toBe("dirty_state_changed");
  });

  it("blocks when dirty content changes under a stable dirty flag", () => {
    const result = compareSnapshots(
      snap({ workingTreeDirty: true }),
      snap({ workingTreeDirty: true, dirtyContentDigest: "d2" }),
    );
    expect(result.stable).toBe(false);
    expect(result.reason).toBe("dirty_content_changed");
  });

  it("allows a stable dirty tree to publish", () => {
    const dirty = snap({ workingTreeDirty: true });
    expect(compareSnapshots(dirty, { ...dirty, capturedAt: "later" })).toEqual({ stable: true });
  });
});

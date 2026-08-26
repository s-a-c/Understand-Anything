/**
 * Pre-analysis git snapshot: HEAD commit and dirty-content fingerprint.
 *
 * Captured before analysis; verified after analysis to reject publication
 * when inputs move mid-run. Stable dirty content publishes with an explicit
 * `workingTreeDirty` warning.
 */

import { createHash } from "node:crypto";
import type { PreAnalysisSnapshot } from "./types.js";
import { trackedExecFile } from "./procs.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return trackedExecFile("git", args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES,
    signal,
  });
}

/** Pathspecs that keep runner-written state out of the dirty fingerprint. */
const UA_DATA_EXCLUDES = [
  ":(exclude).ua",
  ":(exclude).ua/**",
  ":(exclude).understand-anything",
  ":(exclude).understand-anything/**",
] as const;

/**
 * Capture the pre-analysis snapshot for a project root.
 * Throws if the project is not a git repository or HEAD is unreadable —
 * callers treat this as an immediate failure.
 */
export async function capturePreAnalysisSnapshot(
  projectRoot: string,
  options?: { signal?: AbortSignal },
): Promise<PreAnalysisSnapshot> {
  const signal = options?.signal;
  const head = (await runGit(projectRoot, ["rev-parse", "HEAD"], signal)).trim();

  // Dirty set excludes the UA data dirs themselves (they change as we write).
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(projectRoot, ["diff", "--name-only", "-z", "--", ".", ...UA_DATA_EXCLUDES], signal),
    runGit(projectRoot, ["diff", "--cached", "--name-only", "-z", "--", ".", ...UA_DATA_EXCLUDES], signal),
    runGit(
      projectRoot,
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
        ...UA_DATA_EXCLUDES,
      ],
      signal,
    ),
  ]);

  const dirtyFiles = [...new Set([...unstaged, ...staged, ...untracked].filter((p) => p.length > 0))].sort();
  const workingTreeDirty = dirtyFiles.length > 0;

  const digest = createHash("sha256");
  digest.update(`${dirtyFiles.length}\n`);
  for (const file of dirtyFiles) {
    digest.update(file);
    digest.update("\n");
  }

  return {
    headCommitHash: head,
    workingTreeDirty,
    dirtyContentDigest: digest.digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export interface SnapshotComparison {
  /** Publication may proceed. */
  stable: boolean;
  /** Reason instability was detected (empty when stable). */
  reason?: string;
}

/**
 * Compare a post-analysis snapshot against the captured pre-analysis one.
 * HEAD movement always blocks publication. A changed set of dirty files
 * blocks publication only if content actually moved; a stable dirty tree is fine.
 */
export function compareSnapshots(
  before: PreAnalysisSnapshot,
  after: PreAnalysisSnapshot,
): SnapshotComparison {
  if (before.headCommitHash !== after.headCommitHash) {
    return { stable: false, reason: "head_moved" };
  }
  if (
    before.workingTreeDirty &&
    !after.workingTreeDirty
  ) {
    return { stable: false, reason: "dirty_state_changed" };
  }
  if (!before.workingTreeDirty && after.workingTreeDirty) {
    return { stable: false, reason: "dirty_state_changed" };
  }
  if (before.dirtyContentDigest !== after.dirtyContentDigest) {
    return { stable: false, reason: "dirty_content_changed" };
  }
  return { stable: true };
}

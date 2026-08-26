/**
 * Tracked subprocess execution for the runner.
 *
 * Every child the runner spawns is registered here so cancellation and
 * deadlines can terminate the active process group: SIGTERM first, then
 * SIGKILL after a short grace period. Git reads are bounded by their own
 * per-command timeouts as a second belt.
 */

import { execFile, type ChildProcess } from "node:child_process";

const active = new Set<ChildProcess>();

export interface TrackedExecOptions {
  cwd: string;
  timeoutMs: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export function trackedExecFile(
  file: string,
  args: string[],
  options: TrackedExecOptions,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Assigned synchronously right after spawn; the completion callback may
    // fire synchronously under test mocks, so guard every access.
    let child: ChildProcess | null = null;

    const finish = (error: Error | null, stdout: string) => {
      if (child) active.delete(child);
      if (options.signal?.aborted) {
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        rejectPromise(abortError);
        return;
      }
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    };

    child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        encoding: "utf-8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes ?? 32 * 1024 * 1024,
        windowsHide: true,
      },
      finish,
    );
    active.add(child);

    const onAbort = () => {
      try {
        child?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", () => options.signal?.removeEventListener("abort", onAbort));
  });
}

/** SIGTERM every tracked child, then SIGKILL whatever survives the grace. */
export async function terminateTrackedChildren(graceMs = 2_000): Promise<void> {
  const victims = [...active];
  for (const child of victims) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (victims.length === 0) return;

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && active.size > 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const child of [...active]) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Test hook: forget all tracked children. */
export function resetTrackedChildren(): void {
  active.clear();
}

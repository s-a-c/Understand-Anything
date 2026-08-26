/**
 * Shared corpus lock for Understand Anything analysis.
 *
 * One lock covers the whole project corpus: analysis, staging, and
 * publication. Every entry point that mutates corpus state — the ua-runner
 * CLI (single or all-scope), hooks, and interactive flows — must hold this
 * same lock. Contention is a bounded busy result, never a queue.
 *
 * Implementation: O_EXCL create of a JSON holder file under the XDG state
 * dir. Stale locks (dead PID, corrupt file, or age past the hard cap) are
 * reclaimed automatically, so a crashed run can never wedge the corpus.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";

export const LOCK_HARD_CAP_MS = 6 * 60 * 60 * 1000;

export interface LockHolder {
  pid: number;
  host: string;
  purpose: string;
  startedAt: string;
}

export type AcquireResult =
  | { ok: true; path: string }
  | { ok: false; reason: "busy" | "error"; path: string; holder?: LockHolder };

export function corpusLockPath(homeDir: string): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homeDir, ".local", "state");
  return join(stateHome, "ua", "corpus.lock");
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockHolder>;
    if (typeof raw.pid !== "number" || typeof raw.startedAt !== "string") return null;
    return {
      pid: raw.pid,
      host: typeof raw.host === "string" ? raw.host : "",
      purpose: typeof raw.purpose === "string" ? raw.purpose : "",
      startedAt: raw.startedAt,
    };
  } catch {
    return null;
  }
}

function holderIsStale(holder: LockHolder | null, path: string): boolean {
  if (holder === null) return true;
  if (!isAlive(holder.pid)) return true;
  const started = Date.parse(holder.startedAt);
  if (!Number.isFinite(started)) return true;
  if (Date.now() - started > LOCK_HARD_CAP_MS) return true;
  void path;
  return false;
}

/** Best-effort liveness probe used by status(); exported for tests. */
export function lockHolderFor(path: string): { path: string; holder: LockHolder | null; stale: boolean } {
  if (!existsSync(path)) return { path, holder: null, stale: false };
  const holder = readHolder(path);
  return { path, holder, stale: holderIsStale(holder, path) };
}

/**
 * Acquire the corpus lock. Returns ok:false with reason "busy" while a
 * live, fresh holder exists — callers surface this as a bounded busy
 * outcome rather than waiting.
 */
export function acquireCorpusLock(purpose: string, homeDir: string): AcquireResult {
  const path = corpusLockPath(homeDir);
  mkdirSync(join(path, ".."), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (existsSync(path)) {
      const { holder, stale } = lockHolderFor(path);
      if (!stale && holder) {
        return { ok: false, reason: "busy", path, holder };
      }
      // Stale: reclaim by removing and retrying the exclusive create.
      rmSync(path, { force: true });
    }

    const holder: LockHolder = {
      pid: process.pid,
      host: hostname(),
      purpose,
      startedAt: new Date().toISOString(),
    };
    try {
      // Exclusive create on the FINAL path — never tmp+rename, which would
      // silently overwrite a concurrent winner.
      writeFileSync(path, JSON.stringify(holder), { flag: "wx" });
      return { ok: true, path };
    } catch (error) {
      // Lost the create race — loop once to re-evaluate staleness before
      // reporting busy.
      if (attempt === 1) {
        const { holder: winner } = lockHolderFor(path);
        return { ok: false, reason: "busy", path, holder: winner ?? undefined };
      }
    }
  }
  return { ok: false, reason: "error", path };
}

/** Release the corpus lock. Only the holding PID may remove it. */
export function releaseCorpusLock(homeDir: string): boolean {
  const path = corpusLockPath(homeDir);
  if (!existsSync(path)) return false;
  const holder = readHolder(path);
  if (holder && holder.pid !== process.pid) return false;
  rmSync(path, { force: true });
  return true;
}

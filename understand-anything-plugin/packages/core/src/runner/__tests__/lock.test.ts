import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireCorpusLock,
  releaseCorpusLock,
  corpusLockPath,
  lockHolderFor,
} from "../lock.js";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ua-lock-"));
  homes.push(home);
  process.env.XDG_STATE_HOME = join(home, "state");
  return home;
}

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
  delete process.env.XDG_STATE_HOME;
});

describe("corpus lock", () => {
  it("acquires and releases cleanly", () => {
    const home = makeHome();
    const acquired = acquireCorpusLock("test", home);
    expect(acquired.ok).toBe(true);
    expect(existsSync(corpusLockPath(home))).toBe(true);

    const holder = JSON.parse(readFileSync(corpusLockPath(home), "utf-8"));
    expect(holder.purpose).toBe("test");
    expect(holder.pid).toBe(process.pid);

    expect(releaseCorpusLock(home)).toBe(true);
    expect(existsSync(corpusLockPath(home))).toBe(false);
  });

  it("reports busy while a live foreign holder exists", async () => {
    const home = makeHome();
    // Live foreign PID: a real child process that outlives the acquire call.
    const sleeper = spawn("sleep", ["5"], { stdio: "ignore" });

    const path = corpusLockPath(home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ pid: sleeper.pid, host: "other", purpose: "foreign", startedAt: new Date().toISOString() }),
    );

    const result = acquireCorpusLock("mine", home);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("busy");
      expect(result.holder?.pid).toBe(sleeper.pid);
    }

    sleeper.kill("SIGKILL");
  });

  it("reclaims a stale lock whose holder PID is dead", () => {
    const home = makeHome();
    const path = corpusLockPath(home);
    // PID 999999 is effectively never alive in test environments.
    mkdirSync(join(corpusLockPath(home), ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ pid: 999_999_999, host: "ghost", purpose: "dead", startedAt: new Date().toISOString() }),
    );

    const acquired = acquireCorpusLock("fresh", home);
    expect(acquired.ok).toBe(true);
    releaseCorpusLock(home);
  });

  it("reclaims a corrupt lock file", () => {
    const home = makeHome();
    mkdirSync(join(corpusLockPath(home), ".."), { recursive: true });
    writeFileSync(corpusLockPath(home), "{not json at all");
    const acquired = acquireCorpusLock("fresh", home);
    expect(acquired.ok).toBe(true);
    releaseCorpusLock(home);
  });

  it("refuses to release a lock held by another PID", () => {
    const home = makeHome();
    mkdirSync(join(corpusLockPath(home), ".."), { recursive: true });
    writeFileSync(
      corpusLockPath(home),
      JSON.stringify({ pid: process.pid + 1_000_000, host: "x", purpose: "y", startedAt: new Date().toISOString() }),
    );
    expect(releaseCorpusLock(home)).toBe(false);
    expect(existsSync(corpusLockPath(home))).toBe(true);
  });

  it("status reports staleness without modifying anything", () => {
    const home = makeHome();
    expect(lockHolderFor(corpusLockPath(home))).toEqual({
      path: corpusLockPath(home),
      holder: null,
      stale: false,
    });

    mkdirSync(join(corpusLockPath(home), ".."), { recursive: true });
    writeFileSync(
      corpusLockPath(home),
      JSON.stringify({ pid: 999_999_999, host: "g", purpose: "p", startedAt: new Date().toISOString() }),
    );
    const status = lockHolderFor(corpusLockPath(home));
    expect(status.stale).toBe(true);
    expect(status.holder?.pid).toBe(999_999_999);
    expect(existsSync(corpusLockPath(home))).toBe(true);
  });
});

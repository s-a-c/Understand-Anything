import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Record every execFile invocation; pass through to the real implementation.
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

import { loadRegistry } from "../registry.js";
import { acquireCorpusLock, corpusLockPath } from "../lock.js";
import { runJob } from "../job.js";
import type { RunnerEvent, ProviderProfile } from "../types.js";

const profile: ProviderProfile = {
  provider: "operator",
  model: "model-x",
  endpoint: "http://127.0.0.1:9999",
  concurrency: 1,
  budget: 1000,
};

const homes: string[] = [];

/** Pin XDG_STATE_HOME inside a sandbox so tests never touch the real corpus lock. */
function sandboxStateHome(home: string): string {
  process.env.XDG_STATE_HOME = join(home, "state");
  return home;
}

function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ua-job-"));
  homes.push(root);
  writeFileSync(join(root, "index.ts"), "export const v = 1;\n");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf-8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.co"]);
  git(["config", "user.name", "T"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return root;
}

function makePlainDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ua-job-plain-"));
  homes.push(root);
  writeFileSync(join(root, "notes.txt"), "not a git repo");
  return root;
}

interface Fixture {
  home: string;
  registry: ReturnType<typeof loadRegistry>;
  events: RunnerEvent[];
  run: (overrides?: Partial<Parameters<typeof runJob>[0]>) => Promise<Awaited<ReturnType<typeof runJob>>>;
}

/** Three valid git repos registered in deliberately non-alphabetical order. */
function fixtureWithRepos(ids?: string[]): Fixture {
  const home = sandboxStateHome(mkdtempSync(join(tmpdir(), "ua-jobhome-")));
  homes.push(home);
  const order = ids ?? ["z-last", "m-mid", "a-first"];
  const entries = order.map((id) => ({
    id,
    root: makeGitRepo(),
    name: id,
  }));
  const registryPath = join(home, "registry.json");
  writeFileSync(registryPath, JSON.stringify(entries));
  const registry = loadRegistry(registryPath);

  const events: RunnerEvent[] = [];
  const base = {
    scope: "all",
    registry,
    profile,
    emit: (event: RunnerEvent) => events.push(event),
    homeDir: home,
  };
  return {
    home,
    registry,
    events,
    run: (overrides) => runJob({ ...base, ...overrides }),
  };
}

afterEach(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
  homes.length = 0;
  delete process.env.XDG_STATE_HOME;
});

describe("runJob — all-scope success", () => {
  it("runs every project in registry order and publishes each", async () => {
    const fx = fixtureWithRepos();
    const result = await fx.run();

    expect(result.busy).toBe(false);
    expect(result.allOk).toBe(true);
    expect(result.outcomes.map((o) => o.projectId)).toEqual(["z-last", "m-mid", "a-first"]);
    expect(result.outcomes.every((o) => o.status === "ok")).toBe(true);

    // Every repo got a published generation behind its pointer.
    for (const entry of fx.registry) {
      expect(existsSync(join(entry.root, ".ua", "current.json"))).toBe(true);
    }

    // Summary event framed under the reserved "all" id.
    const summary = fx.events.filter((e) => e.project === "all" && e.phase === "complete");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.outcome).toBe("ok");
    expect(summary[0]!.counts).toMatchObject({ projects: 3, ok: 3 });

    // Lock always released.
    expect(existsSync(corpusLockPath(fx.home))).toBe(false);
  });
});

describe("runJob — partial failure isolation", () => {
  it("fails the broken project and continues to later projects", async () => {
    const home = sandboxStateHome(mkdtempSync(join(tmpdir(), "ua-jobhome-")));
    homes.push(home);
    const good1 = makeGitRepo();
    const bad = makePlainDir(); // not a git repository
    const good2 = makeGitRepo();

    const registryPath = join(home, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { id: "first-good", root: good1, name: "g1" },
        { id: "broken-middle", root: bad, name: "b" },
        { id: "last-good", root: good2, name: "g2" },
      ]),
    );

    const events: RunnerEvent[] = [];
    const result = await runJob({
      scope: "all",
      registry: loadRegistry(registryPath),
      profile,
      emit: (e) => events.push(e),
      homeDir: home,
    });

    expect(result.allOk).toBe(false);
    expect(result.outcomes.map((o) => [o.projectId, o.status])).toEqual([
      ["first-good", "ok"],
      ["broken-middle", "failed"],
      ["last-good", "ok"],
    ]);

    const summary = events.find((e) => e.project === "all" && e.phase === "complete")!;
    expect(summary.outcome).toBe("failed");
    expect(summary.counts).toMatchObject({ projects: 3, ok: 2, failed: 1 });

    // Both healthy projects still published.
    expect(existsSync(join(good1, ".ua", "current.json"))).toBe(true);
    expect(existsSync(join(good2, ".ua", "current.json"))).toBe(true);
    expect(existsSync(corpusLockPath(home))).toBe(false);
  });

  it("marks an unknown single id as failed without touching anything", async () => {
    const fx = fixtureWithRepos();
    const result = await fx.run({ scope: "ghost-project" });
    expect(result.allOk).toBe(false);
    expect(result.outcomes).toEqual([
      { projectId: "ghost-project", status: "failed", error: "unknown project id", durationMs: 0 },
    ]);
    expect(fx.events.filter((e) => e.phase === "analysis")).toHaveLength(0);
  });
});

describe("runJob — busy lock", () => {
  it("returns a bounded busy result without running projects", async () => {
    const fx = fixtureWithRepos();

    // Live foreign holder.
    const sleeper = spawn("sleep", ["5"], { stdio: "ignore" });
    mkdirSync(join(corpusLockPath(fx.home), ".."), { recursive: true });
    writeFileSync(
      corpusLockPath(fx.home),
      JSON.stringify({
        pid: sleeper.pid,
        host: "other-host",
        purpose: "foreign-run",
        startedAt: new Date().toISOString(),
      }),
    );

    const result = await fx.run();

    expect(result.busy).toBe(true);
    expect(result.outcomes).toHaveLength(0);
    const busyEvents = fx.events.filter((e) => e.message === "corpus busy");
    expect(busyEvents).toHaveLength(1);
    // No project work happened at all.
    expect(fx.events.filter((e) => e.phase === "start")).toHaveLength(0);

    sleeper.kill("SIGKILL");
  });
});

describe("runJob — cancellation", () => {
  it("stops scheduling new projects when cancelled between projects", async () => {
    const fx = fixtureWithRepos();
    const controller = new AbortController();

    // Cancel as soon as the first project completes.
    let completions = 0;
    const hookedEmit = (event: RunnerEvent) => {
      fx.events.push(event);
      if (event.phase === "complete" && event.project !== "all") {
        completions += 1;
        if (completions === 1) controller.abort();
      }
    };

    const result = await fx.run({ signal: controller.signal, emit: hookedEmit });

    expect(result.cancelled).toBe(true);
    expect(result.allOk).toBe(false);
    expect(result.outcomes[0]!.status).toBe("ok");
    expect(result.outcomes.slice(1).every((o) => o.status === "cancelled")).toBe(true);

    const summary = fx.events.filter((e) => e.project === "all" && e.phase === "complete");
    expect(summary.at(-1)!.outcome).toBe("cancelled");

    // Lock released despite cancellation.
    expect(existsSync(corpusLockPath(fx.home))).toBe(false);
  });

  it("honours a pre-aborted signal by cancelling everything up front", async () => {
    const fx = fixtureWithRepos();
    const controller = new AbortController();
    controller.abort();

    const result = await fx.run({ signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.outcomes.every((o) => o.status === "cancelled")).toBe(true);
    expect(existsSync(corpusLockPath(fx.home))).toBe(false);
  });
});

describe("runJob — deadlines", () => {
  it("produces explicit timeout outcomes and preserves prior generations", async () => {
    const fx = fixtureWithRepos(["only"]);

    // Establish a baseline generation with a normal deadline.
    const first = await fx.run({ scope: "only" });
    expect(first.allOk).toBe(true);
    const pointer = readFileSync(join(fx.registry[0]!.root, ".ua", "current.json"), "utf-8");

    // Second run with an absurdly small per-project deadline times out…
    const second = await fx.run({
      scope: "only",
      projectDeadlineMs: 1,
    });

    if (second.outcomes[0]!.status !== "timeout") {
      console.log("DEBUG-TIMEOUT", JSON.stringify(second.outcomes));
    }
    expect(second.outcomes[0]!.status).toBe("timeout");
    const summary = fx.events.filter((e) => e.project === "all" && e.phase === "complete").at(-1)!;
    expect(summary.outcome).toBe("failed");
    expect(summary.counts).toMatchObject({ timeout: 1 });

    // …while the prior generation stays exactly as published.
    expect(readFileSync(join(fx.registry[0]!.root, ".ua", "current.json"), "utf-8")).toBe(pointer);

    // No staged leftovers anywhere.
    const generationsRoot = join(fx.registry[0]!.root, ".ua", "generations");
    const leftovers = execFileSync("ls", [generationsRoot])
      .toString()
      .split("\n")
      .filter((n) => n.startsWith(".tmp-"));
    expect(leftovers).toHaveLength(0);

    expect(existsSync(corpusLockPath(fx.home))).toBe(false);
  });

  it("applies the whole-job deadline to projects that have not started", async () => {
    const fx = fixtureWithRepos();
    const result = await fx.run({ jobDeadlineMs: 1 });
    // Effectively expired budget: later projects must be timed-out outcomes.
    const statuses = result.outcomes.map((o) => o.status);
    expect(statuses.some((s) => s === "timeout")).toBe(true);
  });
});

describe("runJob — host safety", () => {
  it("never spawns anything but git during a full run", async () => {
    processRecorder.calls.length = 0;
    const fx = fixtureWithRepos();
    await fx.run();

    expect(processRecorder.calls.length).toBeGreaterThan(0);
    for (const call of processRecorder.calls) {
      expect(call.cmd).toBe("git");
    }
  });
});

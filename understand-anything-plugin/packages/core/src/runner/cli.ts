#!/usr/bin/env node
/**
 * ua-runner — versioned non-interactive Understand Anything runner.
 *
 * Contract: exactly one argument, the canonical project id. No paths,
 * commands, flags, providers, models, endpoints, budgets, or ignore
 * patterns are accepted from the caller. Emits versioned newline-delimited
 * events on stdout; human diagnostics go to stderr. Never launches a
 * dashboard and never invokes conversational /understand.
 *
 * Usage: node dist/runner/cli.js <project-id>
 * Env:
 *   UA_RUNNER_REGISTRY   path to a JSON registry file (optional; falls back to
 *                        $XDG_CONFIG_HOME/ua/registry.json, then
 *                        ~/.config/ua/registry.json — see registry.example.json)
 *   UA_RUNNER_PROFILE    JSON provider profile string (required)
 *   UA_RUNNER_FORCE_FULL set to "1" to force full analysis
 */

import { existsSync } from "node:fs";
import { defaultRegistryPath, loadRegistry } from "./registry.js";
import { runJob } from "./job.js";
import { parseRunnerEvent } from "./events.js";
import type { ProviderProfile, RunnerEvent } from "./types.js";

function fail(message: string): never {
  process.stderr.write(`ua-runner: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scope = args[0] ?? "";
  if (
    args.length !== 1 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(scope)
  ) {
    fail("usage: ua-runner <project-id|all> (exactly one canonical id or 'all'; no paths or flags)");
  }

  const homeDir = process.env.HOME ?? "";
  if (homeDir.length === 0) fail("HOME is not set");

  // Registry: explicit env file wins; otherwise the well-known config path.
  // Fail closed when neither exists — never fall back to anything implicit.
  const envPath = process.env.UA_RUNNER_REGISTRY;
  const registryPath = envPath ?? defaultRegistryPath(homeDir);
  if (!existsSync(registryPath)) {
    const source = envPath
      ? `UA_RUNNER_REGISTRY (${envPath})`
      : `the well-known path (${registryPath})`;
    fail(
      `no project registry found at ${source}; ` +
        `create one — see packages/core/registry.example.json`,
    );
  }
  const registry = loadRegistryFile(registryPath);

  if (scope !== "all" && !registry.some((e) => e.id === scope)) {
    fail(`unknown project id: ${scope}`);
  }

  // Profile is required and strictly validated by the host.
  const profile = loadProfile();

  // Events flow on stdout as versioned NDJSON; mirror malformed lines to stderr.
  const emit = (event: unknown) => {
    const line = JSON.stringify(event);
    if (parseRunnerEvent(line) === null) {
      process.stderr.write(`ua-runner: internal event failed schema validation\n`);
      return;
    }
    process.stdout.write(line + "\n");
  };

  const forceFull = process.env.UA_RUNNER_FORCE_FULL === "1";
  const projectDeadlineMs = positiveIntEnv("UA_RUNNER_PROJECT_DEADLINE_SECONDS");
  const jobDeadlineMs = positiveIntEnv("UA_RUNNER_JOB_DEADLINE_SECONDS");

  // SIGINT/SIGTERM cancel the job cooperatively; the job layer terminates
  // tracked children and releases the corpus lock.
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.on(name, () => controller.abort());
  }

  const result = await runJob({
    scope,
    registry,
    profile,
    emit,
    homeDir,
    forceFull,
    ...(projectDeadlineMs ? { projectDeadlineMs } : {}),
    ...(jobDeadlineMs ? { jobDeadlineMs } : {}),
    signal: controller.signal,
  });

  if (result.busy) process.exitCode = 3;
  else if (result.cancelled) process.exitCode = 130;
  else if (!result.allOk) process.exitCode = 1;
}

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a positive integer (seconds)`);
  }
  return value * 1000;
}

function loadRegistryFile(path: string) {
  try {
    return loadRegistry(path);
  } catch {
    fail("invalid UA_RUNNER_REGISTRY file");
  }
}

function loadProfile(): ProviderProfile {
  const raw = process.env.UA_RUNNER_PROFILE;
  if (!raw) fail("UA_RUNNER_PROFILE env var is required (JSON provider profile)");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("UA_RUNNER_PROFILE is not valid JSON");
  }
  const p = parsed as Partial<ProviderProfile> | null;
  if (
    typeof p?.provider !== "string" ||
    typeof p?.model !== "string" ||
    typeof p?.endpoint !== "string" ||
    typeof p?.concurrency !== "number" ||
    typeof p?.budget !== "number"
  ) {
    fail("UA_RUNNER_PROFILE must contain provider, model, endpoint, concurrency, budget");
  }
  return {
    provider: p.provider!,
    model: p.model!,
    endpoint: p.endpoint!,
    concurrency: p.concurrency!,
    budget: p.budget!,
  };
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

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
 *   UA_RUNNER_REGISTRY   path to a JSON registry file (optional; default built-in 12)
 *   UA_RUNNER_PROFILE    JSON provider profile string (required)
 *   UA_RUNNER_FORCE_FULL set to "1" to force full analysis
 */

import { defaultRegistry, loadRegistry } from "./registry.js";
import { runProject } from "./host.js";
import { parseRunnerEvent } from "./events.js";
import type { ProviderProfile, RunnerEvent } from "./types.js";

function fail(message: string): never {
  process.stderr.write(`ua-runner: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectId = args[0] ?? "";
  if (
    args.length !== 1 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(projectId)
  ) {
    fail("usage: ua-runner <project-id> (exactly one canonical id; no paths or flags)");
  }

  const homeDir = process.env.HOME ?? "";
  if (homeDir.length === 0) fail("HOME is not set");

  // Registry: operator-supplied file wins; otherwise the built-in 12.
  const registryPath = process.env.UA_RUNNER_REGISTRY;
  const registry = registryPath ? loadRegistryFile(registryPath) : defaultRegistry(homeDir);

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

  const result = await runProject({
    projectId,
    registry,
    profile,
    emit,
    forceFull,
  });

  if (!result.ok) {
    process.exitCode = 1;
  }
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

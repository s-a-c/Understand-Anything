/**
 * Runner host: orchestrates one canonical project through the full
 * non-interactive analysis pipeline.
 *
 * Pipeline: resolve registry id → validate provider profile → capture
 * pre-analysis snapshot → compute ignore digest → incremental check →
 * analyze (incremental reuse or safe full fallback) → stage → verify
 * snapshot stability → publish atomically. Every step emits versioned
 * events; failure at any point preserves the prior generation.
 *
 * The host NEVER launches a dashboard and NEVER invokes conversational
 * /understand. Analysis here is structural (scan + fingerprints + graph
 * assembly); LLM enrichment is out of scope for the runner boundary.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFingerprintStore, type FingerprintStore } from "../fingerprint.js";
import { PluginRegistry } from "../plugins/registry.js";
import { LanguageRegistry } from "../languages/language-registry.js";
import {
  capturePreAnalysisSnapshot,
  compareSnapshots,
} from "./snapshot.js";
import { computeIgnoreDigest } from "./ignore.js";
import { createEmitter } from "./events.js";
import { publishStaged, stageGeneration, discardStaged, readCurrent } from "./publication.js";
import { RUNNER_VERSION } from "./types.js";
import type {
  GenerationMeta,
  PreAnalysisSnapshot,
  ProviderProfile,
  RegistryEntry,
  RunnerResult,
  RunnerRunOptions,
} from "./types.js";

/** Validate the fixed operator provider profile before any long work. */
export function validateProviderProfile(profile: ProviderProfile): string[] {
  const errors: string[] = [];
  if (typeof profile.provider !== "string" || profile.provider.length === 0) {
    errors.push("provider missing");
  }
  if (typeof profile.model !== "string" || profile.model.length === 0) {
    errors.push("model missing");
  }
  if (typeof profile.endpoint !== "string" || !/^https?:\/\//.test(profile.endpoint)) {
    errors.push("endpoint must be an http(s) URL");
  }
  if (!Number.isFinite(profile.concurrency) || profile.concurrency < 1) {
    errors.push("concurrency must be >= 1");
  }
  if (!Number.isFinite(profile.budget) || profile.budget < 0) {
    errors.push("budget must be >= 0");
  }
  return errors;
}

/** Redacted profile identifier recorded in generations — never secrets. */
export function redactedProfileId(profile: ProviderProfile): string {
  return `${profile.provider}/${profile.model}`;
}

export interface HostDeps {
  /** Injectable analyzer construction for tests (fake providers). */
  buildRegistry?: () => PluginRegistry | Promise<PluginRegistry>;
}

async function defaultBuildRegistry(): Promise<PluginRegistry> {
  const registry = new PluginRegistry(LanguageRegistry.createDefault());
  const [{ TreeSitterPlugin }, { builtinLanguageConfigs }, { registerAllParsers }] =
    await Promise.all([
      import("../plugins/tree-sitter-plugin.js"),
      import("../languages/configs/index.js"),
      import("../plugins/parsers/index.js"),
    ]);
  const tsConfigs = builtinLanguageConfigs.filter((c) => c.treeSitter);
  const tsPlugin = new TreeSitterPlugin(tsConfigs);
  await tsPlugin.init();
  registry.register(tsPlugin);
  registerAllParsers(registry);
  return registry;
}

export async function runProject(options: RunnerRunOptions, deps: HostDeps = {}): Promise<RunnerResult> {
  const { projectId, registry, profile, emit: emitRaw, forceFull } = options;
  const emit = createEmitter(projectId, emitRaw);

  // Deadline controller: a finite server-owned timer aborts an internal
  // signal the whole pipeline observes. External cancellation (if any) is
  // linked into the same signal; only the timer marks the run timedOut.
  let timedOut = false;
  const internalController = new AbortController();
  const signal = internalController.signal;
  const onExternalAbort = () => internalController.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  let deadlineTimer: NodeJS.Timeout | null = null;
  if (options.projectDeadlineMs) {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      internalController.abort();
    }, options.projectDeadlineMs);
    deadlineTimer.unref?.();
  }

  // Staged output must never survive an aborted run: tracked here so any
  // failure/cancel/timeout path can remove it before returning.
  let stagedForCleanup: { dir: string } | null = null;

  try {
    // 1. Resolve canonical id — arbitrary paths never reach this point.
    const entry: RegistryEntry | undefined = registry.find((e) => e.id === projectId);
    if (!entry) {
      emit.emit("error", "unknown project id", { outcome: "failed" });
      return { ok: false, projectId, error: `unknown project id` };
    }

    emit.emit("start", `runner ${RUNNER_VERSION} starting`);

    // 2. Validate the fixed operator profile before any long work.
    const profileErrors = validateProviderProfile(profile);
    if (profileErrors.length > 0) {
      emit.emit("error", `invalid provider profile`, { outcome: "failed" });
      return { ok: false, projectId, error: `invalid provider profile` };
    }

    // 3. Capture pre-analysis git snapshot.
    let pre: PreAnalysisSnapshot;
    try {
      pre = await capturePreAnalysisSnapshot(entry.root, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      emit.emit("error", "git snapshot failed", { outcome: "failed" });
      return { ok: false, projectId, error: "git snapshot failed" };
    }
    emit.emit("snapshot", "pre-analysis snapshot captured", {
      counts: { dirtyFiles: pre.workingTreeDirty ? 1 : 0 },
    });

    // 4. Ignore-policy digest (built-in + data-dir + project precedence).
    const ignorePolicy = computeIgnoreDigest(entry.root);
    emit.emit("ignore-digest", "ignore policy computed");

    // 5. Incremental compatibility check against the current generation.
    const current = readCurrent(entry.root);
    const incrementalCompatible =
      !forceFull &&
      current !== null &&
      current.generation.meta.ignoreDigest === ignorePolicy.digest &&
      current.generation.meta.gitCommitHash === pre.headCommitHash;

    emit.emit(
      "incremental-check",
      incrementalCompatible ? "incremental baseline compatible" : "full analysis required",
      { counts: { incremental: incrementalCompatible ? 1 : 0 } },
    );

    // 6. Structural analysis (scan + fingerprints + graph assembly).
    const buildRegistry = deps.buildRegistry ?? defaultBuildRegistry;
    const pluginRegistry = await buildRegistry();

    // The structural scan is performed by the same scan-project pipeline the
    // interactive skill uses; here it runs headless with no user prompts.
    const { runStructuralScan } = await import("./analysis.js");
    const analysis = await runStructuralScan({
      projectRoot: entry.root,
      pluginRegistry,
      baseline: incrementalCompatible && current !== null ? current.generation : null,
      forceFull: forceFull ?? false,
      signal,
      onProgress: (phase, counts) => emit.emit("analysis", phase, { counts }),
    });

    // 7. Stage the generation.
    emit.emit("staging", "staging generation");
    const metaBase: Omit<GenerationMeta, "manifest"> = {
      projectId,
      gitCommitHash: pre.headCommitHash,
      analyzedAt: new Date().toISOString(),
      analyzedFiles: analysis.analyzedFiles,
      ignoreDigest: ignorePolicy.digest,
      providerProfileId: redactedProfileId(profile),
      preAnalysis: pre,
      workingTreeDirty: pre.workingTreeDirty,
    };
    const staged = stageGeneration({
      projectRoot: entry.root,
      projectId,
      graph: analysis.graph,
      fingerprintsJson: JSON.stringify(analysis.fingerprints, null, 2),
      metaBase,
    });
    stagedForCleanup = staged;

    // 8. Verify inputs did not move during analysis.
    emit.emit("stability-check", "verifying input stability");
    let post: PreAnalysisSnapshot;
    try {
      post = await capturePreAnalysisSnapshot(entry.root, { signal });
    } catch (error) {
      discardStaged(staged);
      if (signal?.aborted) throw error;
      emit.emit("error", "post-analysis snapshot failed", { outcome: "failed" });
      return { ok: false, projectId, error: "post-analysis snapshot failed" };
    }
    const comparison = compareSnapshots(pre, post);
    if (!comparison.stable) {
      discardStaged(staged);
      emit.emit("error", "inputs moved during analysis", { outcome: "failed" });
      return { ok: false, projectId, error: `inputs moved: ${comparison.reason}` };
    }

    // 9. Publish atomically behind the current pointer.
    emit.emit("publication", "publishing generation");
    const generation = publishStaged(staged);
    stagedForCleanup = null;

    emit.emit("complete", "generation published", {
      outcome: "ok",
      counts: {
        files: analysis.analyzedFiles,
        nodes: analysis.graph.nodes.length,
        edges: analysis.graph.edges.length,
        workingTreeDirty: pre.workingTreeDirty ? 1 : 0,
      },
    });
    return { ok: true, projectId, generation };
  } catch (error) {
    if (stagedForCleanup) {
      discardStaged(stagedForCleanup);
      stagedForCleanup = null;
    }
    if (signal?.aborted) {
      if (timedOut) {
        emit.emit("error", "project deadline exceeded", { outcome: "timeout" });
        return { ok: false, projectId, error: "deadline exceeded", timedOut: true };
      }
      emit.emit("error", "run cancelled", { outcome: "cancelled" });
      return { ok: false, projectId, error: "cancelled", cancelled: true };
    }
    const message = error instanceof Error ? error.message : "unknown error";
    emit.emit("error", "run failed", { outcome: "failed" });
    return { ok: false, projectId, error: message };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

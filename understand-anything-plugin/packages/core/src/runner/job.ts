/**
 * Corpus job orchestration: one lock, deterministic order, fail forward.
 *
 * `all` expands the full registry in registry-file order; a single id runs
 * exactly that project. Both hold the same shared corpus lock for the whole
 * job — analysis, staging, publication. Independent project failures are
 * isolated outcomes; later projects continue. Cancellation stops scheduling
 * new projects, terminates tracked children gracefully then forcefully,
 * cleans staging, and releases the lock in a finally path. Prior generations
 * are preserved in every non-success path by the host's publication rules.
 */

import { acquireCorpusLock, releaseCorpusLock } from "./lock.js";
import { terminateTrackedChildren } from "./procs.js";
import { createEmitter } from "./events.js";
import { runProject } from "./host.js";
import type {
  ProjectRegistry,
  ProviderProfile,
  RunnerEvent,
} from "./types.js";

export const DEFAULT_PROJECT_DEADLINE_MS = 15 * 60 * 1000;
export const DEFAULT_JOB_DEADLINE_MS = 4 * 60 * 60 * 1000;

export type ProjectOutcomeStatus = "ok" | "failed" | "timeout" | "cancelled" | "skipped";

export interface JobProjectOutcome {
  projectId: string;
  status: ProjectOutcomeStatus;
  error?: string;
  durationMs: number;
}

export interface JobResult {
  /** Whether every scheduled project completed successfully. */
  allOk: boolean;
  /** True when the lock was held by someone else — nothing ran. */
  busy: boolean;
  /** True when external cancellation stopped the job. */
  cancelled: boolean;
  outcomes: JobProjectOutcome[];
}

export interface RunJobOptions {
  scope: string;
  registry: ProjectRegistry;
  profile: ProviderProfile;
  emit: (event: RunnerEvent) => void;
  homeDir: string;
  jobDeadlineMs?: number;
  projectDeadlineMs?: number;
  signal?: AbortSignal;
  forceFull?: boolean;
}

function expandTargets(scope: string, registry: ProjectRegistry): string[] {
  if (scope === "all") return registry.map((e) => e.id);
  return [scope];
}

export async function runJob(options: RunJobOptions): Promise<JobResult> {
  const { registry, profile, emit: emitRaw, homeDir } = options;
  const summary = createEmitter("all", emitRaw);

  // Lock before ANY project state/intermediate access.
  const lock = acquireCorpusLock(`ua-runner ${options.scope}`, homeDir);
  if (!lock.ok) {
    summary.emit("error", "corpus busy", { outcome: "failed" });
    return { allOk: false, busy: true, cancelled: false, outcomes: [] };
  }

  const jobDeadlineMs = options.jobDeadlineMs ?? DEFAULT_JOB_DEADLINE_MS;
  const jobStarted = Date.now();
  const jobDeadlineAt = jobStarted + jobDeadlineMs;
  const internalController = new AbortController();
  const onExternalAbort = () => internalController.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();

  const outcomes: JobProjectOutcome[] = [];
  let sawExternalCancel = false;

  try {
    const targets = expandTargets(options.scope, registry);

    for (const projectId of targets) {
      if (internalController.signal.aborted) {
        sawExternalCancel = true;
        outcomes.push({
          projectId,
          status: "cancelled",
          durationMs: 0,
        });
        continue;
      }
      if (Date.now() >= jobDeadlineAt) {
        outcomes.push({
          projectId,
          status: "timeout",
          error: "job deadline exceeded before start",
          durationMs: 0,
        });
        continue;
      }
      if (!registry.some((e) => e.id === projectId)) {
        outcomes.push({ projectId, status: "failed", error: "unknown project id", durationMs: 0 });
        continue;
      }

      const remainingJobBudget = Math.max(0, jobDeadlineAt - Date.now());
      const projectDeadlineMs = Math.min(
        options.projectDeadlineMs ?? DEFAULT_PROJECT_DEADLINE_MS,
        remainingJobBudget,
      );

      const startedAt = Date.now();
      try {
        const result = await runProject(
          {
            projectId,
            registry,
            profile,
            emit: emitRaw,
            signal: internalController.signal,
            projectDeadlineMs,
            forceFull: options.forceFull,
          },
          {},
        );
        if (result.ok) {
          outcomes.push({ projectId, status: "ok", durationMs: Date.now() - startedAt });
        } else if (result.timedOut) {
          outcomes.push({
            projectId,
            status: "timeout",
            error: result.error,
            durationMs: Date.now() - startedAt,
          });
        } else if (result.cancelled) {
          sawExternalCancel = true;
          outcomes.push({
            projectId,
            status: "cancelled",
            error: result.error,
            durationMs: Date.now() - startedAt,
          });
        } else {
          outcomes.push({
            projectId,
            status: "failed",
            error: result.error,
            durationMs: Date.now() - startedAt,
          });
        }
      } catch (error) {
        // Host failures must stay isolated; classify and move on.
        const aborted = internalController.signal.aborted;
        outcomes.push({
          projectId,
          status: aborted ? (sawExternalCancel ? "cancelled" : "timeout") : "failed",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
        if (aborted) sawExternalCancel = sawExternalCancel || Boolean(options.signal?.aborted);
      }
    }

    const okCount = outcomes.filter((o) => o.status === "ok").length;
    const failedCount = outcomes.filter((o) => o.status === "failed").length;
    const timeoutCount = outcomes.filter((o) => o.status === "timeout").length;
    const cancelledCount = outcomes.filter((o) => o.status === "cancelled").length;

    summary.emit("complete", "job finished", {
      outcome: sawExternalCancel
        ? "cancelled"
        : okCount === targets.length
          ? "ok"
          : "failed",
      counts: {
        projects: targets.length,
        ok: okCount,
        failed: failedCount,
        timeout: timeoutCount,
        cancelled: cancelledCount,
      },
    });

    return {
      allOk: !sawExternalCancel && failedCount === 0 && timeoutCount === 0 && cancelledCount === 0,
      busy: false,
      cancelled: sawExternalCancel,
      outcomes,
    };
  } finally {
    // Graceful then forceful termination of any active children, then the
    // lock always comes off — even on cancellation or thrown errors.
    if (options.signal?.aborted || internalController.signal.aborted) {
      await terminateTrackedChildren();
    }
    options.signal?.removeEventListener("abort", onExternalAbort);
    releaseCorpusLock(homeDir);
  }
}

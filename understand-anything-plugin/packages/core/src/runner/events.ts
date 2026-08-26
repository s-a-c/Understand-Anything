/**
 * Versioned newline-delimited event protocol.
 *
 * Events contain only canonical project id, phase/type, safe message,
 * outcome, and redacted counts — never paths, secrets, or internals.
 * UA Viewer parses only this schema; malformed events fail the item.
 */

import type { RunnerEvent, RunnerEventPhase, RunnerEventOutcome } from "./types.js";

/** Redaction guard: reject messages containing path separators or home markers. */
function assertSafeMessage(message: string): string {
  if (/[/\\]|~|\.\./.test(message)) {
    return "internal detail redacted";
  }
  return message;
}

export function createEmitter(
  projectId: string,
  writeEvent: (event: RunnerEvent) => void,
): {
  emit: (phase: RunnerEventPhase, message: string, options?: { outcome?: RunnerEventOutcome; counts?: Record<string, number> }) => void;
} {
  return {
    emit(phase, message, options = {}) {
      const event: RunnerEvent = {
        v: 1,
        project: projectId,
        phase,
        message: assertSafeMessage(message),
        ts: new Date().toISOString(),
      };
      if (options.outcome !== undefined) event.outcome = options.outcome;
      if (options.counts !== undefined) event.counts = options.counts;
      writeEvent(event);
    },
  };
}

/**
 * Parse one newline-delimited JSON line into a RunnerEvent.
 * Returns null for malformed lines — the host fails the item on any
 * malformed event rather than guessing intent.
 */
export function parseRunnerEvent(line: string): RunnerEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    typeof candidate.project !== "string" ||
    typeof candidate.phase !== "string" ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }
  const knownPhases = new Set([
    "start", "snapshot", "ignore-digest", "incremental-check", "analysis",
    "staging", "stability-check", "publication", "complete", "error",
  ]);
  if (!knownPhases.has(candidate.phase)) return null;

  const event: RunnerEvent = {
    v: 1,
    project: candidate.project,
    phase: candidate.phase as RunnerEventPhase,
    message: candidate.message,
    ts: typeof candidate.ts === "string" ? candidate.ts : new Date().toISOString(),
  };
  if (
    candidate.outcome === "ok" || candidate.outcome === "skipped" ||
    candidate.outcome === "failed" || candidate.outcome === "cancelled"
  ) {
    event.outcome = candidate.outcome;
  }
  if (typeof candidate.counts === "object" && candidate.counts !== null && !Array.isArray(candidate.counts)) {
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(candidate.counts)) {
      if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
    }
    event.counts = counts;
  }
  return event;
}

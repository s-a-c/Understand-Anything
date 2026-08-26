/**
 * Runner types for the Understand Anything non-interactive runner boundary.
 *
 * This module defines the canonical project registry, fixed provider profile,
 * ignore-policy digest, generation format, and structured event protocol.
 */

// ---- Runner version ----

export const RUNNER_VERSION = "1.1.0" as const;

// ---- Project registry ----

export interface RegistryEntry {
  /** Canonical project id (e.g. "home", "infra-images", "infra-caddy"). */
  id: string;
  /** Absolute path to the project root on disk. */
  root: string;
  /** Human-readable display name. */
  name: string;
}

export type ProjectRegistry = RegistryEntry[];

// ---- Provider profile ----

export interface ProviderProfile {
  /** Operator-configured provider identifier (redacted in events). */
  provider: string;
  /** Model identifier (redacted in events). */
  model: string;
  /** API endpoint (redacted in events). */
  endpoint: string;
  /** Max concurrent analyses (currently always 1). */
  concurrency: number;
  /** Token budget per analysis (informational). */
  budget: number;
}

// ---- Ignore policy ----

export interface IgnorePolicy {
  /** SHA-256 digest of the effective ignore rules (built-in + data-dir + project). */
  digest: string;
  /** The resolved rules used to compute the digest. */
  rules: string[];
}

// ---- Fingerprints pre-analysis ----

export interface PreAnalysisSnapshot {
  /** Git HEAD commit hash at snapshot time. */
  headCommitHash: string;
  /** Whether the working tree has uncommitted changes. */
  workingTreeDirty: boolean;
  /** SHA-256 digest of dirty content (sorted file contents). Empty if clean. */
  dirtyContentDigest: string;
  /** Timestamp of the snapshot. */
  capturedAt: string;
}

// ---- Generation ----

export interface GenerationManifest {
  /** SHA-256 of the knowledge-graph.json content. */
  graphHash: string;
  /** SHA-256 of the fingerprints.json content. */
  fingerprintsHash: string;
  /** ISO timestamp of publication. */
  publishedAt: string;
  /** Runner version that produced this generation. */
  runnerVersion: string;
}

export interface GenerationMeta {
  /** Canonical project id. */
  projectId: string;
  /** Git commit hash the analysis was based on. */
  gitCommitHash: string;
  /** ISO timestamp when analysis started. */
  analyzedAt: string;
  /** Number of files analyzed. */
  analyzedFiles: number;
  /** Ignore-policy digest used for this generation. */
  ignoreDigest: string;
  /** Redacted provider profile id (not the secret). */
  providerProfileId: string;
  /** Pre-analysis snapshot for HEAD/dirty verification. */
  preAnalysis: PreAnalysisSnapshot;
  /** Manifest with content hashes. */
  manifest: GenerationManifest;
  /** Whether the working tree was dirty at analysis time. */
  workingTreeDirty: boolean;
}

export interface Generation {
  /** Absolute path to the generation directory. */
  dir: string;
  /** Metadata about this generation. */
  meta: GenerationMeta;
}

// ---- Current pointer ----

export interface CurrentPointer {
  /** The generation directory name (hash). */
  generation: string;
  /** ISO timestamp when this pointer was last updated. */
  updatedAt: string;
}

// ---- Event protocol ----

export type RunnerEventPhase =
  | "start"
  | "snapshot"
  | "ignore-digest"
  | "incremental-check"
  | "analysis"
  | "staging"
  | "stability-check"
  | "publication"
  | "complete"
  | "error";

export type RunnerEventOutcome = "ok" | "skipped" | "failed" | "cancelled" | "timeout";

export interface RunnerEvent {
  /** Protocol version. */
  v: 1;
  /** Canonical project id. */
  project: string;
  /** Event phase. */
  phase: RunnerEventPhase;
  /** Human-readable safe message (no paths, secrets, or internals). */
  message: string;
  /** Outcome (only on terminal events). */
  outcome?: RunnerEventOutcome;
  /** Redacted counts (files analyzed, nodes, edges, etc.). */
  counts?: Record<string, number>;
  /** ISO timestamp. */
  ts: string;
}

// ---- Runner options ----

export interface RunnerRunOptions {
  /** Canonical project id to analyze. */
  projectId: string;
  /** The project registry. */
  registry: ProjectRegistry;
  /** Fixed provider profile. */
  profile: ProviderProfile;
  /** The event writer (emits newline-delimited JSON to stdout). */
  emit: (event: RunnerEvent) => void;
  /** Optional: force full analysis even if incremental is possible. */
  forceFull?: boolean;
  /** Cooperative cancellation; checked between phases and files. */
  signal?: AbortSignal;
  /** Finite per-project deadline in ms; expiry yields a timeout outcome. */
  projectDeadlineMs?: number;
}

// ---- Runner result ----

export interface RunnerResult {
  /** Whether the run completed successfully. */
  ok: boolean;
  /** The project id that was analyzed. */
  projectId: string;
  /** The generation that was published (if any). */
  generation?: Generation;
  /** Error message (if not ok). */
  error?: string;
  /** True when the run ended because its deadline expired. */
  timedOut?: boolean;
  /** True when the run ended because of external cancellation. */
  cancelled?: boolean;
}

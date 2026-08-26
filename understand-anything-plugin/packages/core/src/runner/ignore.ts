/**
 * Ignore-policy digest computation. Merges built-in defaults, data-directory
 * ignore, and project `.understandignore` into a deterministic digest that
 * participates in incremental compatibility checks.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IGNORE_PATTERNS } from "../ignore-filter.js";
import type { IgnorePolicy } from "./types.js";

/**
 * Resolve the data directory for a project (.ua or legacy .understand-anything).
 */
function resolveUaDir(projectRoot: string): string {
  const legacy = join(projectRoot, ".understand-anything");
  return existsSync(legacy) ? legacy : join(projectRoot, ".ua");
}

/**
 * Read and parse a `.understandignore` file, returning non-comment, non-empty lines.
 */
function readIgnoreFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Compute the ignore-policy digest from the three ignore layers:
 * 1. Built-in defaults (always excluded)
 * 2. Data-directory `.understandignore` (operator-tuned)
 * 3. Project-root `.understandignore` (project-specific)
 *
 * The digest is a SHA-256 hash of the sorted, deduplicated rule set.
 * A changed digest invalidates incremental assumptions.
 */
export function computeIgnoreDigest(projectRoot: string): IgnorePolicy {
  const uaDir = resolveUaDir(projectRoot);

  const builtIn = DEFAULT_IGNORE_PATTERNS.map((p) => `+${p}`);
  const dataDir = readIgnoreFile(join(uaDir, ".understandignore")).map(
    (p) => `d${p}`,
  );
  const project = readIgnoreFile(join(projectRoot, ".understandignore")).map(
    (p) => `p${p}`,
  );

  // Deduplicate and sort for deterministic hashing
  const all = [...new Set([...builtIn, ...dataDir, ...project])].sort();
  const digest = createHash("sha256").update(all.join("\n")).digest("hex");

  return { digest, rules: all };
}

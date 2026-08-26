/**
 * Runner-owned project registry. Maps canonical project ids to their
 * roots on disk. The registry is operator-owned and validated before
 * analysis; only non-secret profile/provider/model identifiers are recorded.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ProjectRegistry, RegistryEntry } from "./types.js";

/**
 * Resolve a canonical project id to its registry entry.
 * Throws if the id is not in the registry or the root does not exist.
 */
export function resolveProject(
  registry: ProjectRegistry,
  projectId: string,
): RegistryEntry {
  const entry = registry.find((e) => e.id === projectId);
  if (!entry) {
    throw new Error(`Unknown project id: ${projectId}`);
  }
  if (!existsSync(entry.root)) {
    throw new Error(`Project root does not exist: ${entry.root}`);
  }
  return entry;
}

/**
 * Load a project registry from a JSON file.
 * The file should contain an array of { id, root, name } objects.
 * Relative roots are resolved against the file's directory.
 */
export function loadRegistry(filePath: string): ProjectRegistry {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!Array.isArray(raw)) {
    throw new Error(`Registry file must contain an array: ${filePath}`);
  }
  return raw.map((entry: Record<string, string>) => {
    if (typeof entry.id !== "string" || typeof entry.root !== "string") {
      throw new Error(
        `Registry entry must have "id" and "root" strings: ${JSON.stringify(entry)}`,
      );
    }
    return {
      id: entry.id,
      root: isAbsolute(entry.root)
        ? entry.root
        : resolve(filePath, "..", entry.root),
      name: typeof entry.name === "string" ? entry.name : entry.id,
    };
  });
}

/**
 * Default well-known registry location: `$XDG_CONFIG_HOME/ua/registry.json`,
 * falling back to `~/.config/ua/registry.json`. The registry itself is
 * operator configuration and is never shipped in the repository; see
 * `packages/core/registry.example.json` for the schema.
 */
export function defaultRegistryPath(homeDir: string): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homeDir, ".config");
  return join(configHome, "ua", "registry.json");
}

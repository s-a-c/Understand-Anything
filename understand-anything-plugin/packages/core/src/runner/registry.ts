/**
 * Runner-owned project registry. Maps canonical project ids to their
 * roots on disk. The registry is operator-owned and validated before
 * analysis; only non-secret profile/provider/model identifiers are recorded.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
 * The canonical 12-project corpus. Ids are stable identifiers; roots resolve
 * under the operator's home directory and entries whose root does not exist
 * are filtered out at load time.
 */
export function defaultRegistry(homeDir: string): ProjectRegistry {
  const projects: Array<{ id: string; relativeRoot: string; name: string }> = [
    { id: "home", relativeRoot: "", name: "Home workspace" },
    { id: "samples-20260717", relativeRoot: "Herd/samples-20260717", name: "Samples 20260717" },
    { id: "caddy", relativeRoot: "infra/caddy", name: "Central Caddy" },
    { id: "control-plane", relativeRoot: "infra/control-plane", name: "Control Plane" },
    { id: "docs-site", relativeRoot: "infra/docs-site", name: "Docs Site" },
    { id: "hermes-agent", relativeRoot: "infra/hermes-agent", name: "Hermes Agent" },
    { id: "infisical", relativeRoot: "infra/infisical", name: "Infisical" },
    { id: "odysseus", relativeRoot: "infra/odysseus", name: "Odysseus" },
    { id: "siyuan", relativeRoot: "infra/siyuan", name: "SiYuan" },
    { id: "shared", relativeRoot: "infra/shared", name: "Infra Shared" },
    { id: "agent-skills", relativeRoot: "Projects/agent-skills", name: "Agent Skills" },
    { id: "the-hub--spoke", relativeRoot: "Projects/the-hub--spoke", name: "The Hub & Spoke" },
  ];

  return projects
    .filter((p) => p.relativeRoot.length === 0 || existsSync(resolve(homeDir, p.relativeRoot)))
    .map((p) => ({
      id: p.id,
      root: p.relativeRoot.length === 0 ? homeDir : resolve(homeDir, p.relativeRoot),
      name: p.name,
    }));
}

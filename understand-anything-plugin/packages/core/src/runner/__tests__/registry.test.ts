import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject, loadRegistry, defaultRegistry } from "../registry.js";

describe("resolveProject", () => {
  const registry = [
    { id: "alpha", root: tmpdir(), name: "Alpha" },
  ];

  it("resolves a canonical id", () => {
    expect(resolveProject(registry, "alpha").name).toBe("Alpha");
  });

  it("rejects ids outside the registry", () => {
    expect(() => resolveProject(registry, "beta")).toThrow(/Unknown project id/);
  });

  it("rejects arbitrary paths masquerading as ids", () => {
    expect(() => resolveProject(registry, "/etc/passwd")).toThrow(/Unknown project id/);
    expect(() => resolveProject(registry, "../home")).toThrow(/Unknown project id/);
  });

  it("rejects entries whose root does not exist", () => {
    expect(() =>
      resolveProject([{ id: "ghost", root: join(tmpdir(), "does-not-exist-xyz"), name: "Ghost" }], "ghost"),
    ).toThrow(/does not exist/);
  });
});

describe("loadRegistry", () => {
  it("loads entries and resolves relative roots against the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-reg-"));
    mkdirSync(join(dir, "proj"), { recursive: true });
    const file = join(dir, "registry.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "rel-proj", root: "./proj", name: "Relative" },
        { id: "abs", root: dir, name: "Absolute" },
      ]),
    );
    const registry = loadRegistry(file);
    expect(registry).toHaveLength(2);
    expect(registry[0]!.root).toBe(join(dir, "proj"));
    expect(registry[1]!.root).toBe(dir);
  });

  it("rejects non-array registries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-reg-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }));
    expect(() => loadRegistry(file)).toThrow(/array/);
  });

  it("rejects entries missing id or root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-reg-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify([{ id: "only-id" }]));
    expect(() => loadRegistry(file)).toThrow(/id.*root|root.*id/i);
  });
});

describe("defaultRegistry", () => {
  it("returns only projects whose roots exist on disk", () => {
    const home = mkdtempSync(join(tmpdir(), "ua-home-"));
    mkdirSync(join(home, "infra", "caddy"), { recursive: true });
    const registry = defaultRegistry(home);
    const ids = registry.map((e) => e.id);
    expect(ids).toContain("caddy");
    expect(ids).not.toContain("control-plane");
  });

  it("exactly covers the canonical corpus ids", () => {
    const home = mkdtempSync(join(tmpdir(), "ua-home-"));
    for (const rel of [
      "Herd/samples-20260717", "infra/caddy", "infra/control-plane", "infra/docs-site",
      "infra/hermes-agent", "infra/infisical", "infra/odysseus", "infra/siyuan",
      "infra/shared", "Projects/agent-skills", "Projects/the-hub--spoke",
    ]) {
      mkdirSync(join(home, rel), { recursive: true });
    }
    const ids = defaultRegistry(home).map((e) => e.id).sort();
    expect(ids).toEqual([
      "agent-skills", "caddy", "control-plane", "docs-site", "hermes-agent",
      "home", "infisical", "odysseus", "samples-20260717", "shared", "siyuan",
      "the-hub--spoke",
    ]);
  });

  it("never contains path-like ids", () => {
    const registry = defaultRegistry(tmpdir());
    for (const entry of registry) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

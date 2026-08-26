import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject, loadRegistry, defaultRegistryPath } from "../registry.js";

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

  it("loads the shipped registry.example.json without mutation", () => {
    // The example lives at packages/core/registry.example.json; resolve from
    // this test's location (src/runner/__tests__) relative to src/.
    const example = join(__dirname, "..", "..", "..", "registry.example.json");
    expect(existsSync(example)).toBe(true);
    const registry = loadRegistry(example);
    expect(registry.length).toBeGreaterThan(0);
    for (const entry of registry) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(entry.root).toMatch(/^\//);
    }
  });
});

describe("defaultRegistryPath", () => {
  it("honors XDG_CONFIG_HOME when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-xdg-"));
    const original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      expect(defaultRegistryPath(tmpdir())).toBe(join(dir, "ua", "registry.json"));
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original;
    }
  });

  it("falls back to ~/.config when XDG is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "ua-home-"));
    const original = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(defaultRegistryPath(home)).toBe(join(home, ".config", "ua", "registry.json"));
    } finally {
      if (original !== undefined) process.env.XDG_CONFIG_HOME = original;
    }
  });
});

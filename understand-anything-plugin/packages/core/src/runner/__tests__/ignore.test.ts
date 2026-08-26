import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeIgnoreDigest } from "../ignore.js";

function makeProject(withDataIgnore?: string[], withProjectIgnore?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "ua-ign-"));
  if (withDataIgnore) {
    mkdirSync(join(root, ".ua"), { recursive: true });
    writeFileSync(join(root, ".ua", ".understandignore"), withDataIgnore.join("\n"));
  }
  if (withProjectIgnore) {
    writeFileSync(join(root, ".understandignore"), withProjectIgnore.join("\n"));
  }
  return root;
}

describe("computeIgnoreDigest", () => {
  it("is deterministic for the same inputs", () => {
    const root = makeProject(["dist/"], ["docs/*.md"]);
    expect(computeIgnoreDigest(root)).toEqual(computeIgnoreDigest(root));
  });

  it("changes when a data-directory ignore rule changes", () => {
    const before = computeIgnoreDigest(makeProject(["dist/"]));
    const after = computeIgnoreDigest(makeProject(["dist/", "coverage/"]));
    expect(before.digest).not.toBe(after.digest);
  });

  it("changes when a project-root ignore rule changes", () => {
    const before = computeIgnoreDigest(makeProject(undefined, ["a/"]));
    const after = computeIgnoreDigest(makeProject(undefined, ["a/", "b/"]));
    expect(before.digest).not.toBe(after.digest);
  });

  it("layers all three precedence sources into the rules", () => {
    const policy = computeIgnoreDigest(makeProject(["from-data-dir/"], ["from-project-root/"]));
    // Built-in defaults present
    expect(policy.rules.some((r) => r === "+node_modules/")).toBe(true);
    // Data-dir rule namespaced and present
    expect(policy.rules.some((r) => r === "dfrom-data-dir/")).toBe(true);
    // Project rule namespaced and present
    expect(policy.rules.some((r) => r === "pfrom-project-root/")).toBe(true);
  });

  it("ignores comments and blank lines in ignore files", () => {
    const bare = computeIgnoreDigest(makeProject([]));
    const commented = computeIgnoreDigest(makeProject(["# just a comment", "", "   "]));
    expect(bare.digest).toBe(commented.digest);
  });

  it("produces a sha256 digest", () => {
    const policy = computeIgnoreDigest(makeProject());
    expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

import { describe, it, expect } from "vitest";
import { createEmitter, parseRunnerEvent } from "../events.js";
import type { RunnerEvent } from "../types.js";

function collect(): { events: RunnerEvent[]; emit: ReturnType<typeof createEmitter>["emit"]; write: (e: RunnerEvent) => void } {
  const events: RunnerEvent[] = [];
  const emitter = createEmitter("proj", (event) => events.push(event));
  return { events, emit: emitter.emit, write: (e) => events.push(e) };
}

describe("createEmitter", () => {
  it("emits version-1 events with canonical fields", () => {
    const { events, emit } = collect();
    emit("start", "beginning");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.v).toBe(1);
    expect(event.project).toBe("proj");
    expect(event.phase).toBe("start");
    expect(event.message).toBe("beginning");
    expect(typeof event.ts).toBe("string");
  });

  it("carries outcome and redacted counts on request", () => {
    const { events, emit } = collect();
    emit("complete", "done", { outcome: "ok", counts: { files: 12 } });
    expect(events[0]!.outcome).toBe("ok");
    expect(events[0]!.counts).toEqual({ files: 12 });
  });

  it("redacts messages containing paths", () => {
    const { events, emit } = collect();
    emit("error", "failed at /Users/alice/secret/file.ts");
    emit("error", "failed at ~/home/path");
    emit("error", "failed with ../traversal");
    for (const event of events) {
      expect(event.message).toBe("internal detail redacted");
    }
  });

  it("passes through safe messages unchanged", () => {
    const { events, emit } = collect();
    emit("analysis", "analyzing files");
    expect(events[0]!.message).toBe("analyzing files");
  });
});

describe("parseRunnerEvent", () => {
  it("round-trips an emitted event", () => {
    const { events, emit } = collect();
    emit("publication", "publishing", { counts: { nodes: 3 } });
    const parsed = parseRunnerEvent(JSON.stringify(events[0]));
    expect(parsed).toEqual(events[0]);
  });

  it("returns null for malformed JSON", () => {
    expect(parseRunnerEvent("{not json")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseRunnerEvent(JSON.stringify({ v: 1, project: "p" }))).toBeNull();
    expect(parseRunnerEvent(JSON.stringify({ v: 1, phase: "start", message: "m" }))).toBeNull();
    expect(parseRunnerEvent(JSON.stringify({ project: "p", phase: "start", message: "m" }))).toBeNull();
  });

  it("returns null for unknown protocol versions and phases", () => {
    expect(parseRunnerEvent(JSON.stringify({ v: 2, project: "p", phase: "start", message: "m" }))).toBeNull();
    expect(parseRunnerEvent(JSON.stringify({ v: 1, project: "p", phase: "mystery", message: "m" }))).toBeNull();
  });

  it("returns null for non-object lines", () => {
    expect(parseRunnerEvent("42")).toBeNull();
    expect(parseRunnerEvent('"text"')).toBeNull();
    expect(parseRunnerEvent("[1,2]")).toBeNull();
  });

  it("drops unknown outcomes and non-finite counts instead of failing", () => {
    const parsed = parseRunnerEvent(
      JSON.stringify({ v: 1, project: "p", phase: "start", message: "m", outcome: "weird", counts: { a: Infinity, b: 2, c: "x" } }),
    );
    expect(parsed?.outcome).toBeUndefined();
    expect(parsed?.counts).toEqual({ b: 2 });
  });
});

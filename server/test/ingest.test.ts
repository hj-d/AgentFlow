import { describe, it, expect } from "vitest";
import { isValidInput, normalize, ingestBatch } from "../src/ingest.js";

const validMessage = {
  kind: "message",
  deviceId: "d1",
  teamId: "planner",
  agentId: "a1",
  from: "d1/planner/a1",
  to: "d1/planner/a2",
};

const validBlackboard = {
  kind: "blackboard",
  deviceId: "d1",
  teamId: "planner",
  agentId: "a1",
  op: "write",
  key: "bb:plan:1",
};

const validAgent = {
  kind: "agent",
  deviceId: "d1",
  teamId: "planner",
  agentId: "a1",
  status: "online",
  role: "worker",
};

describe("isValidInput", () => {
  it("accepts a well-formed message", () => {
    expect(isValidInput(validMessage)).toBe(true);
  });

  it("accepts a well-formed blackboard event", () => {
    expect(isValidInput(validBlackboard)).toBe(true);
  });

  it("accepts a well-formed agent lifecycle event (online/offline)", () => {
    expect(isValidInput(validAgent)).toBe(true);
    expect(isValidInput({ ...validAgent, status: "offline" })).toBe(true);
  });

  it("rejects an agent event with an invalid/missing status", () => {
    const { status, ...noStatus } = validAgent;
    expect(isValidInput(noStatus)).toBe(false);
    expect(isValidInput({ ...validAgent, status: "busy" })).toBe(false);
  });

  it("rejects an agent event missing hierarchy fields", () => {
    expect(isValidInput({ ...validAgent, agentId: "" })).toBe(false);
  });

  it("accepts a message with to=null (broadcast)", () => {
    expect(isValidInput({ ...validMessage, to: null })).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(isValidInput({ ...validMessage, kind: "telemetry" })).toBe(false);
  });

  it("rejects missing hierarchy fields", () => {
    expect(isValidInput({ ...validMessage, deviceId: "" })).toBe(false);
    expect(isValidInput({ ...validMessage, teamId: undefined })).toBe(false);
    const { agentId, ...noAgent } = validMessage;
    expect(isValidInput(noAgent)).toBe(false);
  });

  it("rejects message without 'from' or 'to' key", () => {
    const { from, ...noFrom } = validMessage;
    expect(isValidInput(noFrom)).toBe(false);
    const { to, ...noTo } = validMessage;
    expect(isValidInput(noTo)).toBe(false);
  });

  it("rejects blackboard without key", () => {
    const { key, ...noKey } = validBlackboard;
    expect(isValidInput(noKey)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isValidInput(null)).toBe(false);
    expect(isValidInput("nope")).toBe(false);
    expect(isValidInput(42)).toBe(false);
  });
});

describe("normalize", () => {
  it("fills eventId and ts when absent", () => {
    const e = normalize(validMessage as any, 1000);
    expect(e.ts).toBe(1000);
    expect(typeof e.eventId).toBe("string");
    expect(e.eventId.length).toBeGreaterThan(0);
  });

  it("preserves producer-supplied eventId and ts", () => {
    const e = normalize({ ...validMessage, eventId: "fixed", ts: 5 } as any, 1000);
    expect(e.eventId).toBe("fixed");
    expect(e.ts).toBe(5);
  });

  it("generates unique eventIds across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(normalize(validMessage as any, 1000).eventId);
    expect(ids.size).toBe(1000);
  });
});

describe("ingestBatch", () => {
  it("accepts a single object", () => {
    expect(ingestBatch(validMessage, 1)).toHaveLength(1);
  });

  it("accepts an array and drops invalid items", () => {
    const out = ingestBatch([validMessage, { kind: "bad" }, validBlackboard], 1);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.kind)).toEqual(["message", "blackboard"]);
  });

  it("accepts a mixed batch of all three kinds", () => {
    const out = ingestBatch([validAgent, validMessage, validBlackboard], 1);
    expect(out.map((e) => e.kind)).toEqual(["agent", "message", "blackboard"]);
  });

  it("returns empty for fully invalid input", () => {
    expect(ingestBatch([{}, null, "x"], 1)).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { Hub } from "../src/hub.js";
import type { FlowEvent } from "../src/types.js";

// Fake 'ws' surface supporting inbound join/subscribe and reading server messages.
class FakeWS {
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private handlers: Record<string, ((...a: any[]) => void)[]> = {};
  send(d: string) {
    this.sent.push(d);
  }
  on(ev: string, cb: (...a: any[]) => void) {
    (this.handlers[ev] ??= []).push(cb);
  }
  fire(ev: string, arg?: any) {
    for (const cb of this.handlers[ev] ?? []) cb(arg);
  }
  join(space: string) {
    this.fire("message", JSON.stringify({ type: "join", space }));
  }
  subscribe(taskId: string | null) {
    this.fire("message", JSON.stringify({ type: "subscribeTask", taskId }));
  }
  msgs() {
    return this.sent.map((s) => JSON.parse(s));
  }
  events() {
    return this.msgs().filter((m) => m.type === "event").map((m) => m.event as FlowEvent);
  }
  lastSnapshot() {
    return [...this.msgs()].reverse().find((m) => m.type === "snapshot");
  }
  lastTasks() {
    return [...this.msgs()].reverse().find((m) => m.type === "tasks");
  }
  lastSpaces() {
    return [...this.msgs()].reverse().find((m) => m.type === "spaces");
  }
}

let id = 0;
function agentEvt(space: string, agent: string): FlowEvent {
  return { kind: "agent", eventId: "e" + id++, ts: id, space, deviceId: "d1", teamId: "t1", agentId: agent, status: "online", role: "worker" };
}
function msgEvt(space: string, taskId: string): FlowEvent {
  return { kind: "message", eventId: "e" + id++, ts: id, space, deviceId: "d1", teamId: "t1", agentId: "a1", from: "d1/t1/a1", to: "d1/t1/a2", op: "send", taskId };
}

describe("Hub: workspace (space) isolation", () => {
  it("does not deliver one space's presence to a client in another space", () => {
    const hub = new Hub(100);
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.join("alice");
    ws.sent.length = 0;
    hub.ingest(agentEvt("alice", "a1")); // same space → delivered
    hub.ingest(agentEvt("bob", "b1")); // other space → not delivered
    const got = ws.events().map((e) => e.agentId);
    expect(got).toContain("a1");
    expect(got).not.toContain("b1");
    hub.stop();
  });

  it("isolates a focused task across spaces (same taskId, different space)", () => {
    const hub = new Hub(100);
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.join("alice");
    ws.subscribe("shared-id");
    ws.sent.length = 0;
    hub.ingest(msgEvt("alice", "shared-id")); // delivered
    hub.ingest(msgEvt("bob", "shared-id")); // same taskId but other space → NOT delivered
    const got = ws.events();
    expect(got).toHaveLength(1);
    expect(got[0].space).toBe("alice");
    hub.stop();
  });

  it("scopes the snapshot's presence to the joined space", () => {
    const hub = new Hub(100);
    hub.ingest(agentEvt("alice", "a1"));
    hub.ingest(agentEvt("bob", "b1"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.join("alice");
    const snap = ws.lastSnapshot();
    expect(snap.space).toBe("alice");
    const agents = snap.events.map((e: FlowEvent) => e.agentId);
    expect(agents).toEqual(["a1"]); // bob's b1 excluded
    hub.stop();
  });

  it("scopes task summaries to the joined space", () => {
    const hub = new Hub(100);
    hub.ingest(msgEvt("alice", "t-alice"));
    hub.ingest(msgEvt("bob", "t-bob"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.join("alice");
    const tasks = ws.lastTasks();
    const ids = tasks.tasks.map((t: any) => t.taskId);
    expect(ids).toEqual(["t-alice"]);
    expect(hub.taskCount("alice")).toBe(1);
    expect(hub.taskCount("bob")).toBe(1);
    hub.stop();
  });

  it("publishes a directory of all workspaces with counts", () => {
    const hub = new Hub(100);
    hub.ingest(agentEvt("alice", "a1"));
    hub.ingest(agentEvt("alice", "a2"));
    hub.ingest(msgEvt("bob", "t-bob"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    const dir = ws.lastSpaces();
    const byName = Object.fromEntries(dir.spaces.map((s: any) => [s.space, s]));
    expect(byName["alice"].agents).toBe(2);
    expect(byName["bob"].tasks).toBe(1);
    expect(hub.spaceCount).toBe(2);
    hub.stop();
  });

  it("defaults to the 'default' space when none is given (backward compatible)", () => {
    const hub = new Hub(100);
    const ws = new FakeWS();
    hub.addClient(ws as any); // no join → default space
    hub.ingest(agentEvt("default", "a1"));
    expect(ws.events().map((e) => e.agentId)).toContain("a1");
    hub.stop();
  });
});

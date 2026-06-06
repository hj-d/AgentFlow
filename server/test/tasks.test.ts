import { describe, it, expect } from "vitest";
import { Hub } from "../src/hub.js";
import type { FlowEvent } from "../src/types.js";

// Fake of the 'ws' surface the Hub uses, incl. inbound messages.
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
}

let id = 0;
function agentEvt(agent: string, device = "d1", team = "t1"): FlowEvent {
  return { kind: "agent", eventId: "e" + id++, ts: id, deviceId: device, teamId: team, agentId: agent, status: "online", role: "worker" };
}
function msgEvt(taskId: string, device = "d1", team = "t1", agent = "a1"): FlowEvent {
  return { kind: "message", eventId: "e" + id++, ts: id, deviceId: device, teamId: team, agentId: agent, from: `${device}/${team}/${agent}`, to: `${device}/${team}/a2`, op: "send", taskId };
}

describe("Hub: task registry", () => {
  it("aggregates events into task summaries (count, kind, devices)", () => {
    const hub = new Hub(100);
    hub.ingest(msgEvt("t1", "d1"));
    hub.ingest(msgEvt("t1", "d2"));
    hub.ingest({ ...msgEvt("t1", "d1"), kind: "blackboard", op: "write", key: "k", value: 1 } as any);
    expect(hub.taskCount).toBe(1);

    const ws = new FakeWS();
    hub.addClient(ws as any);
    const tasksMsg = ws.msgs().find((m) => m.type === "tasks");
    expect(tasksMsg).toBeTruthy();
    const t1 = tasksMsg.tasks.find((t: any) => t.taskId === "t1");
    expect(t1.count).toBe(3);
    expect(t1.messages).toBe(2);
    expect(t1.blackboard).toBe(1);
    expect(t1.devices.sort()).toEqual(["d1", "d2"]);
    expect(tasksMsg.total).toBe(1);
    hub.stop();
  });
});

describe("Hub: subscription filtering (scalability)", () => {
  it("delivers agent presence to everyone regardless of subscription", () => {
    const hub = new Hub(100);
    const ws = new FakeWS();
    hub.addClient(ws as any);
    hub.ingest(agentEvt("a1"));
    expect(ws.events().some((e) => e.kind === "agent")).toBe(true);
    hub.stop();
  });

  it("does NOT send task events to a client that hasn't subscribed", () => {
    const hub = new Hub(100);
    const ws = new FakeWS();
    hub.addClient(ws as any);
    hub.ingest(msgEvt("t1"));
    expect(ws.events().some((e) => e.kind === "message")).toBe(false);
    hub.stop();
  });

  it("streams only the subscribed task's events", () => {
    const hub = new Hub(100);
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.subscribe("t1");
    ws.sent.length = 0; // ignore the re-sync snapshot
    hub.ingest(msgEvt("t1"));
    hub.ingest(msgEvt("t2"));
    const got = ws.events();
    expect(got).toHaveLength(1);
    expect(got[0].taskId).toBe("t1");
    hub.stop();
  });

  it("two clients each receive only their own focused task", () => {
    const hub = new Hub(100);
    const a = new FakeWS();
    const b = new FakeWS();
    hub.addClient(a as any);
    hub.addClient(b as any);
    a.subscribe("t1");
    b.subscribe("t2");
    a.sent.length = 0;
    b.sent.length = 0;
    hub.ingest(msgEvt("t1"));
    hub.ingest(msgEvt("t2"));
    expect(a.events().map((e) => e.taskId)).toEqual(["t1"]);
    expect(b.events().map((e) => e.taskId)).toEqual(["t2"]);
    hub.stop();
  });
});

describe("Hub: scoped snapshot on subscribe", () => {
  it("re-syncs with presence + only the focused task's events", () => {
    const hub = new Hub(100);
    hub.ingest(agentEvt("a1"));
    hub.ingest(msgEvt("t1"));
    hub.ingest(msgEvt("t2"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.subscribe("t1");
    const snap = ws.lastSnapshot();
    expect(snap.taskId).toBe("t1");
    const kinds = snap.events.map((e: FlowEvent) => e.kind);
    expect(kinds).toContain("agent"); // presence included
    const taskIds = snap.events.filter((e: FlowEvent) => e.kind === "message").map((e: FlowEvent) => e.taskId);
    expect(taskIds).toEqual(["t1"]); // t2 excluded
    hub.stop();
  });
});

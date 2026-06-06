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
  recv(msg: unknown) {
    this.fire("message", JSON.stringify(msg));
  }
  msgs() {
    return this.sent.map((s) => JSON.parse(s));
  }
  lastTasks() {
    return [...this.msgs()].reverse().find((m) => m.type === "tasks");
  }
  lastSpaces() {
    return [...this.msgs()].reverse().find((m) => m.type === "spaces");
  }
  lastSnapshot() {
    return [...this.msgs()].reverse().find((m) => m.type === "snapshot");
  }
}

let id = 0;
function msgEvt(taskId: string, space?: string, device = "d1"): FlowEvent {
  return {
    kind: "message",
    eventId: "e" + id++,
    ts: ++id,
    space,
    deviceId: device,
    teamId: "t1",
    agentId: "a1",
    from: `${device}/t1/a1`,
    to: `${device}/t1/a2`,
    op: "send",
    taskId,
  };
}
function agentEvt(agent: string, space?: string): FlowEvent {
  return { kind: "agent", eventId: "e" + id++, ts: ++id, space, deviceId: "d1", teamId: "t1", agentId: agent, status: "online", role: "worker" };
}

describe("Hub: deleteTask", () => {
  it("removes the task summary and its buffered events", () => {
    const hub = new Hub(100);
    hub.ingest(msgEvt("t1"));
    hub.ingest(msgEvt("t1"));
    hub.ingest(msgEvt("t2"));
    expect(hub.taskCount()).toBe(2);

    hub.deleteTask("default", "t1");
    expect(hub.taskCount()).toBe(1);

    // a fresh client should not see t1 in its task list
    const ws = new FakeWS();
    hub.addClient(ws as any);
    const ids = ws.lastTasks().tasks.map((t: any) => t.taskId);
    expect(ids).toEqual(["t2"]);
    hub.stop();
  });

  it("un-focuses a client viewing the deleted task and pushes an updated task list", () => {
    const hub = new Hub(100);
    hub.ingest(msgEvt("t1"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.recv({ type: "subscribeTask", taskId: "t1" });
    ws.sent.length = 0;

    ws.recv({ type: "deleteTask", taskId: "t1" });
    // server re-syncs the (now task-less) client and sends a fresh task list
    expect(ws.lastSnapshot().taskId).toBeNull();
    expect(ws.lastTasks().tasks.map((t: any) => t.taskId)).toEqual([]);
    expect(hub.taskCount()).toBe(0);
    hub.stop();
  });

  it("is a no-op for an unknown task id", () => {
    const hub = new Hub(100);
    hub.ingest(msgEvt("t1"));
    hub.deleteTask("default", "nope");
    expect(hub.taskCount()).toBe(1);
    hub.stop();
  });
});

describe("Hub: clearSpace", () => {
  it("wipes tasks but keeps the agent roster (presence)", () => {
    const hub = new Hub(100);
    hub.ingest(agentEvt("a1"));
    hub.ingest(msgEvt("t1"));
    hub.ingest(msgEvt("t2"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.sent.length = 0;

    ws.recv({ type: "clearSpace" });
    expect(hub.taskCount()).toBe(0);
    // presence survives → snapshot still carries the agent
    const snap = ws.lastSnapshot();
    expect(snap.events.some((e: FlowEvent) => e.kind === "agent" && e.agentId === "a1")).toBe(true);
    expect(ws.lastTasks().tasks).toEqual([]);
    hub.stop();
  });
});

describe("Hub: deleteSpace", () => {
  it("removes a whole workspace from the directory", () => {
    const hub = new Hub(100);
    hub.ingest(msgEvt("t1", "alice"));
    hub.ingest(msgEvt("t1", "bob"));
    expect(hub.spaceCount).toBe(2);

    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.sent.length = 0;

    ws.recv({ type: "deleteSpace", space: "alice" });
    expect(hub.spaceCount).toBe(1);
    const spaceNames = ws.lastSpaces().spaces.map((s: any) => s.space);
    expect(spaceNames).toContain("bob");
    expect(spaceNames).not.toContain("alice");
    hub.stop();
  });

  it("clears the view of clients currently in the deleted space", () => {
    const hub = new Hub(100);
    hub.ingest(msgEvt("t1", "alice"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    ws.recv({ type: "join", space: "alice" });
    ws.recv({ type: "subscribeTask", taskId: "t1" });
    ws.sent.length = 0;

    ws.recv({ type: "deleteSpace", space: "alice" });
    const snap = ws.lastSnapshot();
    expect(snap.space).toBe("alice");
    expect(snap.events).toEqual([]);
    expect(snap.taskId).toBeNull();
    hub.stop();
  });
});

import { describe, it, expect, vi } from "vitest";
import { Hub } from "../src/hub.js";
import type { FlowEvent } from "../src/types.js";

// Minimal fake of the 'ws' WebSocket surface the Hub uses.
class FakeWS {
  static OPEN = 1;
  static CLOSED = 3;
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private handlers: Record<string, ((...a: any[]) => void)[]> = {};

  send(data: string) {
    this.sent.push(data);
  }
  on(ev: string, cb: (...a: any[]) => void) {
    (this.handlers[ev] ??= []).push(cb);
  }
  emit(ev: string) {
    for (const cb of this.handlers[ev] ?? []) cb();
  }
  messages() {
    return this.sent.map((s) => JSON.parse(s));
  }
  events() {
    return this.messages().filter((m) => m.type === "event");
  }
}

// presence events are delivered to every client regardless of task subscription
const agent = (id: string): FlowEvent => ({
  kind: "agent",
  eventId: id,
  ts: 1,
  deviceId: "d1",
  teamId: "t1",
  agentId: id,
  status: "online",
  role: "worker",
});

describe("Hub", () => {
  it("sends a snapshot of presence on connect", () => {
    const hub = new Hub(10);
    hub.ingest(agent("a1"));
    const ws = new FakeWS();
    hub.addClient(ws as any);
    const snap = ws.messages().find((m) => m.type === "snapshot");
    expect(snap.events.map((e: FlowEvent) => e.agentId)).toContain("a1");
    hub.stop();
  });

  it("broadcasts agent presence to all connected clients", () => {
    const hub = new Hub(10);
    const a = new FakeWS();
    const b = new FakeWS();
    hub.addClient(a as any);
    hub.addClient(b as any);
    hub.ingest(agent("a1"));
    expect(a.events().some((m) => m.event.agentId === "a1")).toBe(true);
    expect(b.events().some((m) => m.event.agentId === "a1")).toBe(true);
    hub.stop();
  });

  it("stops sending to a client after it closes", () => {
    const hub = new Hub(10);
    const ws = new FakeWS();
    hub.addClient(ws as any);
    const before = ws.sent.length;
    ws.emit("close");
    hub.ingest(agent("a1"));
    expect(ws.sent.length).toBe(before);
    expect(hub.clientCount).toBe(0);
    hub.stop();
  });

  it("does not send to a client whose socket is not OPEN", () => {
    const hub = new Hub(10);
    const ws = new FakeWS();
    ws.readyState = FakeWS.CLOSED;
    hub.addClient(ws as any);
    hub.ingest(agent("a1"));
    expect(ws.sent.length).toBe(0);
    hub.stop();
  });

  it("emits a periodic stats message with the event rate", () => {
    vi.useFakeTimers();
    const hub = new Hub(10);
    const ws = new FakeWS();
    hub.addClient(ws as any);
    hub.ingest(agent("a1"));
    hub.ingest(agent("a2"));
    vi.advanceTimersByTime(1000);
    const stats = ws.messages().find((m) => m.type === "stats");
    expect(stats).toBeTruthy();
    expect(stats.rate).toBe(2);
    expect(stats.connected).toBe(1);
    hub.stop();
    vi.useRealTimers();
  });
});

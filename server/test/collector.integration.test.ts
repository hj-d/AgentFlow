import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { createCollector, type Collector } from "../src/app.js";

let collector: Collector;
let port: number;
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  collector = createCollector({ snapshotSize: 100 });
  port = await collector.listen(0); // ephemeral port
});

afterAll(async () => {
  await collector.close();
});

function post(body: unknown) {
  return fetch(base() + "/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

interface WsClient {
  ws: WebSocket;
  /** Resolves with the first message (past or future) matching predicate. */
  waitFor: (predicate: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
}

// Buffer messages from socket creation so we never miss the connect-time snapshot.
function openWs(): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const buffer: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    buffer.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        waiters[i].resolve(m);
        waiters.splice(i, 1);
      }
    }
  });

  const waitFor = (predicate: (m: any) => boolean, timeoutMs = 3000) => {
    const existing = buffer.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
      waiters.push({ pred: predicate, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  };

  return new Promise((resolve) => ws.on("open", () => resolve({ ws, waitFor })));
}

const sample = {
  kind: "message" as const,
  deviceId: "d1",
  teamId: "planner",
  agentId: "a1",
  from: "d1/planner/a1",
  to: "d1/planner/a2",
  msgType: "task",
  traceId: "t1",
  body: { x: 1 },
};

describe("collector HTTP", () => {
  it("GET /health reports ok", async () => {
    const r = await fetch(base() + "/health").then((x) => x.json());
    expect(r.ok).toBe(true);
    expect(typeof r.clients).toBe("number");
  });

  it("POST /ingest accepts a valid event", async () => {
    const r = await post(sample);
    expect(r.accepted).toBe(1);
  });

  it("POST /ingest accepts a batch and drops invalid entries", async () => {
    const r = await post([sample, { kind: "bad" }, sample]);
    expect(r.accepted).toBe(2);
  });
});

describe("collector WebSocket", () => {
  it("delivers an agent presence snapshot on connect", async () => {
    await post({ kind: "agent", deviceId: "dS", teamId: "ops", agentId: "snap1", status: "online", role: "worker" });
    const { ws, waitFor } = await openWs();
    const snap = await waitFor((m) => m.type === "snapshot");
    expect(snap.events.some((e: any) => e.kind === "agent" && e.agentId === "snap1")).toBe(true);
    ws.close();
  });

  it("delivers an agent lifecycle event to clients (no subscription needed)", async () => {
    const { ws, waitFor } = await openWs();
    const wait = waitFor((m) => m.type === "event" && m.event.kind === "agent" && m.event.agentId === "newbie");
    await post({ kind: "agent", deviceId: "d9", teamId: "ops", agentId: "newbie", status: "online", role: "worker" });
    const got = await wait;
    expect(got.event.status).toBe("online");
    ws.close();
  });

  it("does NOT push task events to an unsubscribed client", async () => {
    const { ws, waitFor } = await openWs();
    await waitFor((m) => m.type === "snapshot");
    let leaked = false;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "event" && m.event.taskId === "unsub-task") leaked = true;
    });
    await post({ ...sample, taskId: "unsub-task" });
    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toBe(false);
    ws.close();
  });

  it("streams a task's events after the client subscribes to it", async () => {
    const { ws, waitFor } = await openWs();
    await waitFor((m) => m.type === "snapshot");
    ws.send(JSON.stringify({ type: "subscribeTask", taskId: "T-42" }));
    await new Promise((r) => setTimeout(r, 50)); // let subscription register
    const wait = waitFor((m) => m.type === "event" && m.event.taskId === "T-42");
    await post({ ...sample, taskId: "T-42" });
    const got = await wait;
    expect(got.event.body).toEqual({ x: 1 });
    ws.close();
  });

  it("emits periodic task summaries", async () => {
    await post({ ...sample, taskId: "T-sum" });
    const { ws, waitFor } = await openWs();
    const tasks = await waitFor((m) => m.type === "tasks" && m.tasks.some((t: any) => t.taskId === "T-sum"), 4000);
    const t = tasks.tasks.find((t: any) => t.taskId === "T-sum");
    expect(t.messages).toBeGreaterThanOrEqual(1);
    expect(typeof tasks.total).toBe("number");
    ws.close();
  });

  it("reflects connected client count in /health", async () => {
    const { ws, waitFor } = await openWs();
    await waitFor((m) => m.type === "snapshot");
    const r = await fetch(base() + "/health").then((x) => x.json());
    expect(r.clients).toBeGreaterThanOrEqual(1);
    ws.close();
  });
});

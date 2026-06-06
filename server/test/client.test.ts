import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { AgentFlowClient } from "../../clients/ts/agentflow.js";
import { createCollector, type Collector } from "../src/app.js";

function mockFetch() {
  const calls: any[] = [];
  const impl = vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return {};
  });
  return { impl, calls };
}

describe("AgentFlowClient batching", () => {
  it("does not flush until batchSize is reached (timer disabled)", () => {
    const { impl, calls } = mockFetch();
    const af = new AgentFlowClient({ url: "x", deviceId: "d1", batchSize: 3, flushIntervalMs: 0, fetchImpl: impl });
    af.message({ teamId: "t", agentId: "a", from: "a", to: "b" });
    af.message({ teamId: "t", agentId: "a", from: "a", to: "b" });
    expect(impl).not.toHaveBeenCalled();
    expect(af.pending).toBe(2);
    void calls;
  });

  it("auto-flushes when batchSize is reached", async () => {
    const { impl, calls } = mockFetch();
    const af = new AgentFlowClient({ url: "x", deviceId: "d1", batchSize: 2, flushIntervalMs: 0, fetchImpl: impl });
    af.message({ teamId: "t", agentId: "a", from: "a", to: "b" });
    af.message({ teamId: "t", agentId: "a", from: "a", to: "b" });
    await Promise.resolve();
    expect(impl).toHaveBeenCalledTimes(1);
    expect(calls[0]).toHaveLength(2);
  });

  it("applies default deviceId/teamId, overridable per call", async () => {
    const { impl, calls } = mockFetch();
    const af = new AgentFlowClient({ url: "x", deviceId: "d-default", teamId: "t-default", batchSize: 1, flushIntervalMs: 0, fetchImpl: impl });
    af.message({ agentId: "a", from: "a", to: "b" });
    af.message({ agentId: "a", from: "a", to: "b", deviceId: "d-override" });
    await Promise.resolve();
    expect(calls[0][0].deviceId).toBe("d-default");
    expect(calls[0][0].teamId).toBe("t-default");
    expect(calls[1][0].deviceId).toBe("d-override");
  });

  it("builds correct message / blackboard shapes", async () => {
    const { impl, calls } = mockFetch();
    const af = new AgentFlowClient({ url: "x", deviceId: "d1", teamId: "t", batchSize: 3, flushIntervalMs: 0, fetchImpl: impl });
    af.message({ agentId: "a1", from: "a1", to: "a2", msgType: "task", traceId: "tr", body: { n: 1 } });
    af.blackboardWrite({ agentId: "a1", key: "k", value: { v: 2 }, traceId: "tr" });
    af.blackboardRead({ agentId: "a2", key: "k", traceId: "tr" });
    await af.flush();
    const [m, w, r] = calls[0];
    expect(m).toMatchObject({ kind: "message", op: "send", from: "a1", to: "a2", msgType: "task", body: { n: 1 } });
    expect(w).toMatchObject({ kind: "blackboard", op: "write", key: "k", value: { v: 2 } });
    expect(r).toMatchObject({ kind: "blackboard", op: "read", key: "k" });
  });

  it("builds agent lifecycle (online/offline) shapes", async () => {
    const { impl, calls } = mockFetch();
    const af = new AgentFlowClient({ url: "x", deviceId: "d1", teamId: "t", batchSize: 2, flushIntervalMs: 0, fetchImpl: impl });
    af.online({ agentId: "a1", role: "planner" });
    af.offline({ agentId: "a1" });
    await af.flush();
    const [on, off] = calls[0];
    expect(on).toMatchObject({ kind: "agent", status: "online", agentId: "a1", role: "planner", deviceId: "d1", teamId: "t" });
    expect(off).toMatchObject({ kind: "agent", status: "offline", agentId: "a1" });
  });

  it("re-queues the batch and calls onError on send failure", async () => {
    const onError = vi.fn();
    const impl = vi.fn(async () => {
      throw new Error("collector down");
    });
    const af = new AgentFlowClient({ url: "x", deviceId: "d1", batchSize: 10, flushIntervalMs: 0, fetchImpl: impl, onError });
    af.message({ teamId: "t", agentId: "a", from: "a", to: "b" });
    await af.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(af.pending).toBe(1); // event preserved for retry
  });

  it("drops oldest beyond maxQueue", () => {
    const { impl } = mockFetch();
    const af = new AgentFlowClient({ url: "x", deviceId: "d1", batchSize: 99999, flushIntervalMs: 0, maxQueue: 5, fetchImpl: impl });
    for (let i = 0; i < 20; i++) af.message({ teamId: "t", agentId: String(i), from: "a", to: "b" });
    expect(af.pending).toBe(5);
  });

  it("close() flushes remaining events", async () => {
    const { impl, calls } = mockFetch();
    const af = new AgentFlowClient({ url: "x", deviceId: "d1", batchSize: 99, flushIntervalMs: 0, fetchImpl: impl });
    af.message({ teamId: "t", agentId: "a", from: "a", to: "b" });
    await af.close();
    expect(impl).toHaveBeenCalledTimes(1);
    expect(calls[0]).toHaveLength(1);
  });
});

describe("AgentFlowClient -> real collector (end-to-end)", () => {
  let collector: Collector;
  let port: number;

  beforeAll(async () => {
    collector = createCollector({ snapshotSize: 100 });
    port = await collector.listen(0);
  });
  afterAll(async () => {
    await collector.close();
  });

  it("delivers SDK-emitted events to a WebSocket client subscribed to the task", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "subscribeTask", taskId: "e2e" }));
    await new Promise((r) => setTimeout(r, 50));

    const received = new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === "event" && m.event.taskId === "e2e") resolve(m.event);
      });
    });

    const af = new AgentFlowClient({
      url: `http://127.0.0.1:${port}/ingest`,
      deviceId: "edge-1",
      teamId: "planner",
      batchSize: 1,
      flushIntervalMs: 0,
    });
    af.message({ agentId: "a1", from: "edge-1/planner/a1", to: "edge-1/planner/a2", taskId: "e2e", body: { hi: true } });

    const event = await received;
    expect(event.deviceId).toBe("edge-1");
    expect(event.body).toEqual({ hi: true });
    expect(event.eventId).toBeTruthy();
    await af.close();
    ws.close();
  });
});

/**
 * AgentFlow TS SDK tests — run with the web project's vitest:
 *
 *   cd web && npx vitest run ../clients/ts/agentflow.test.ts
 *
 * Uses an injected fetchImpl (no network) and validates the wire JSON with
 * the REAL server-side validator (server/src/ingest.ts), so the SDK and the
 * collector can never silently drift apart.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFlowClient } from "./agentflow";
import { isValidInput } from "../../server/src/ingest.js";

// ---- injectable fetch harness ----

interface SentCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function makeFetch(behaviors: Array<(call: SentCall) => unknown | Promise<unknown>> = []) {
  const calls: SentCall[] = [];
  const fetchImpl = (url: string, init: SentCall["init"]) => {
    const call = { url, init };
    calls.push(call);
    const behave = behaviors[calls.length - 1];
    return Promise.resolve(behave ? behave(call) : { ok: true });
  };
  const bodies = () => calls.map((c) => JSON.parse(c.init.body) as Record<string, unknown>[]);
  return { calls, bodies, fetchImpl };
}

const URL = "http://collector:3001/ingest";

function client(extra: Partial<ConstructorParameters<typeof AgentFlowClient>[0]> = {}) {
  const f = makeFetch();
  const af = new AgentFlowClient({
    url: URL,
    agentId: "hub",
    space: "home",
    flushIntervalMs: 0, // no timer unless a test opts in
    fetchImpl: f.fetchImpl,
    ...extra,
  });
  return { af, ...f };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---- batching ----

describe("batching", () => {
  it("does not send below batchSize, sends one POST at the threshold", async () => {
    const { af, calls, bodies } = client({ batchSize: 3 });

    af.bbWrite({ key: "k1" });
    af.bbWrite({ key: "k2" });
    expect(calls.length).toBe(0);
    expect(af.pending).toBe(2);

    af.bbWrite({ key: "k3" }); // threshold reached -> auto-flush
    await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(bodies()[0].map((e) => e.key)).toEqual(["k1", "k2", "k3"]);
    expect(af.pending).toBe(0);
  });

  it("flush() sends whatever is pending and is a no-op on an empty queue", async () => {
    const { af, calls } = client({ batchSize: 100 });

    await af.flush();
    expect(calls.length).toBe(0); // nothing queued -> no request

    af.message({ title: "hi", content: "there" });
    await af.flush();
    expect(calls.length).toBe(1);

    await af.flush();
    expect(calls.length).toBe(1); // still nothing new
  });

  it("auto-flushes on the interval timer; close() flushes and stops it", async () => {
    vi.useFakeTimers();
    const { af, calls } = client({ batchSize: 100, flushIntervalMs: 250 });

    af.bbRead({ key: "cfg" });
    expect(calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(calls.length).toBe(1);

    af.bbRead({ key: "cfg2" });
    await af.close(); // flushes the straggler...
    expect(calls.length).toBe(2);

    af.bbRead({ key: "after-close" }); // ...and the timer is gone
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(2);
    expect(af.pending).toBe(1);
  });
});

// ---- failure handling ----

describe("failure handling", () => {
  it("re-queues the batch (in order, ahead of newer events) when the send rejects", async () => {
    const errors: unknown[] = [];
    // first call rejects, second succeeds
    const f = makeFetch([
      () => { throw new Error("ECONNREFUSED"); },
      () => ({ ok: true }),
    ]);
    const af = new AgentFlowClient({
      url: URL, agentId: "hub", flushIntervalMs: 0, batchSize: 100,
      fetchImpl: f.fetchImpl, onError: (e) => errors.push(e),
    });

    af.bbWrite({ key: "a" });
    af.bbWrite({ key: "b" });
    await af.flush();
    expect(errors.length).toBe(1); // swallowed, surfaced via onError only
    expect(af.pending).toBe(2);    // batch is back in the queue

    af.bbWrite({ key: "c" });      // newer event lands BEHIND the re-queued batch
    await af.flush();
    expect(f.calls.length).toBe(2);
    expect(f.bodies()[1].map((e) => e.key)).toEqual(["a", "b", "c"]);
    expect(af.pending).toBe(0);
  });

  it("treats a resolved HTTP error response (ok:false) as a failure", async () => {
    const errors: unknown[] = [];
    const f = makeFetch([() => ({ ok: false, status: 503 }), () => ({ ok: true })]);
    const af = new AgentFlowClient({
      url: URL, agentId: "hub", flushIntervalMs: 0,
      fetchImpl: f.fetchImpl, onError: (e) => errors.push(e),
    });

    af.message({ title: "t", content: "c" });
    await af.flush();
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("503");
    expect(af.pending).toBe(1);

    await af.flush(); // retry succeeds
    expect(af.pending).toBe(0);
    expect(f.calls.length).toBe(2);
  });

  it("never throws into agent code, even when fetch explodes synchronously", async () => {
    const f = makeFetch([() => { throw new Error("boom"); }]);
    const af = new AgentFlowClient({ url: URL, agentId: "hub", flushIntervalMs: 0, batchSize: 1, fetchImpl: f.fetchImpl });

    expect(() => af.toolStart({ tool: "edit_video" })).not.toThrow(); // batchSize 1 -> immediate flush
    await expect(af.flush()).resolves.toBeUndefined();
  });

  it("drops the oldest events when the queue exceeds maxQueue", async () => {
    const { af, bodies } = client({ batchSize: 100, maxQueue: 3 });

    for (const key of ["k1", "k2", "k3", "k4", "k5"]) af.bbWrite({ key });
    expect(af.pending).toBe(3);

    await af.flush();
    expect(bodies()[0].map((e) => e.key)).toEqual(["k3", "k4", "k5"]); // newest survive
  });
});

// ---- defaults ----

describe("default agentId / space", () => {
  it("applies client defaults but never overrides per-event values", async () => {
    const { af, bodies } = client({ batchSize: 100 });

    af.bbRead({ key: "x" });
    af.bbRead({ key: "y", agentId: "pc", space: "prod" });
    await af.flush();

    const [a, b] = bodies()[0];
    expect(a).toMatchObject({ agentId: "hub", space: "home" });
    expect(b).toMatchObject({ agentId: "pc", space: "prod" });
  });

  it("omits space from the wire JSON when no default is set (undefined is not serialized)", async () => {
    const f = makeFetch();
    const af = new AgentFlowClient({ url: URL, agentId: "hub", flushIntervalMs: 0, fetchImpl: f.fetchImpl });

    af.agentStart({});
    await af.flush();
    expect("space" in f.bodies()[0][0]).toBe(false);
  });

  it("an event with no agentId anywhere is rejected by server ingest rules", async () => {
    const f = makeFetch();
    const af = new AgentFlowClient({ url: URL, flushIntervalMs: 0, fetchImpl: f.fetchImpl }); // no default agentId

    af.bbRead({ key: "x" });
    await af.flush();
    expect(isValidInput(f.bodies()[0][0])).toBe(false);
  });
});

// ---- exact wire JSON for all 7 kinds, validated by the real server validator ----

describe("wire format (all 7 kinds)", () => {
  it("POSTs the exact JSON the server contract expects", async () => {
    const { af, calls, bodies } = client({ batchSize: 100 });

    af.agentStart({ role: "orchestrator", label: "HomeHub" });
    af.toolStart({ tool: "edit_video", input: { file: "raw.mp4" }, taskId: "t-1" });
    af.toolEnd({
      tool: "edit_video", status: "ok", output: { file: "out.mp4" },
      summary: "1080p · 32s", taskId: "t-1", causedBy: "evt-42",
    });
    af.dispatch({ from: "hub", to: "pc", task: "영상 편집해줘", payload: { res: "1080p" }, taskId: "t-1", traceId: "tr-1" });
    af.bbWrite({ key: "video_result", value: { file: "out.mp4" }, taskId: "t-1" });
    af.broadcast({ from: "hub", to: ["pc", "tv"], key: "task_req", message: "check the blackboard", taskId: "t-1" });
    af.taskInput({ request: "영상 만들어줘", scenario: "S1", taskId: "t-1" });
    af.message({ title: "Planning", content: "Splitting into 3 subtasks", taskId: "t-1" });
    await af.flush();

    // transport
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");

    // exact payloads (toStrictEqual: no extra/missing keys allowed)
    const base = { agentId: "hub", space: "home" };
    expect(bodies()[0]).toStrictEqual([
      { kind: "agent", phase: "start", role: "orchestrator", label: "HomeHub", ...base },
      { kind: "tool", phase: "start", tool: "edit_video", input: { file: "raw.mp4" }, taskId: "t-1", ...base },
      {
        kind: "tool", phase: "end", tool: "edit_video", status: "ok", output: { file: "out.mp4" },
        summary: "1080p · 32s", taskId: "t-1", causedBy: "evt-42", ...base,
      },
      {
        kind: "delegate", phase: "dispatch", from: "hub", to: "pc", task: "영상 편집해줘",
        payload: { res: "1080p" }, taskId: "t-1", traceId: "tr-1", ...base,
      },
      { kind: "blackboard", op: "write", key: "video_result", value: { file: "out.mp4" }, taskId: "t-1", ...base },
      {
        kind: "noti", phase: "broadcast", from: "hub", to: ["pc", "tv"], key: "task_req",
        message: "check the blackboard", taskId: "t-1", ...base,
      },
      { kind: "task", phase: "input", request: "영상 만들어줘", scenario: "S1", taskId: "t-1", ...base },
      { kind: "message", title: "Planning", content: "Splitting into 3 subtasks", taskId: "t-1", ...base },
    ]);

    // every event passes the server's own ingest validation
    for (const event of bodies()[0]) {
      expect(isValidInput(event), `server rejects ${JSON.stringify(event)}`).toBe(true);
    }
  });

  it("covers the remaining phases (agentEnd, return, bbRead, ack, taskOutput) — all server-valid", async () => {
    const { af, bodies } = client({ batchSize: 100 });

    af.agentEnd({});
    af.return({ from: "pc", to: "hub", payload: { ok: true }, taskId: "t-1" });
    af.bbRead({ key: "video_result", taskId: "t-1" });
    af.ack({ from: "pc", to: "hub", key: "task_req", taskId: "t-1" });
    af.taskOutput({ result: { file: "out.mp4" }, taskId: "t-1" });
    await af.flush();

    const sent = bodies()[0];
    expect(sent.map((e) => [e.kind, e.phase ?? e.op])).toEqual([
      ["agent", "end"],
      ["delegate", "return"],
      ["blackboard", "read"],
      ["noti", "ack"],
      ["task", "output"],
    ]);
    for (const event of sent) expect(isValidInput(event)).toBe(true);
  });
});

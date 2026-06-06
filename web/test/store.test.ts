import { describe, it, expect, beforeEach } from "vitest";
import { useStore, EDGE_TTL_MS } from "../src/store";
import type { FlowEvent } from "../src/types";
import { BLACKBOARD_ID } from "../src/types";

function reset() {
  useStore.setState({
    connected: false,
    paused: false,
    rate: 0,
    events: [],
    agents: {},
    blackboard: {},
    pulses: [],
    edges: {},
    tasks: {},
    tasksTotal: 0,
    selectedTask: null,
    space: "default",
    spaces: [],
    filters: { device: null, team: null, kind: "all", text: "" },
  });
}

let seq = 0;
function msg(over: Partial<Extract<FlowEvent, { kind: "message" }>> = {}): FlowEvent {
  return {
    kind: "message",
    eventId: "m" + seq++,
    ts: 1000 + seq,
    deviceId: "d1",
    teamId: "planner",
    agentId: "a1",
    from: "d1/planner/a1",
    to: "d1/planner/a2",
    op: "send",
    ...over,
  };
}
function bb(over: Partial<Extract<FlowEvent, { kind: "blackboard" }>> = {}): FlowEvent {
  return {
    kind: "blackboard",
    eventId: "b" + seq++,
    ts: 1000 + seq,
    deviceId: "d1",
    teamId: "planner",
    agentId: "a1",
    op: "write",
    key: "bb:plan:1",
    ...over,
  };
}
function agent(over: Partial<Extract<FlowEvent, { kind: "agent" }>> = {}): FlowEvent {
  return {
    kind: "agent",
    eventId: "ag" + seq++,
    ts: 1000 + seq,
    deviceId: "d1",
    teamId: "planner",
    agentId: "a1",
    status: "online",
    ...over,
  };
}

describe("store: agents", () => {
  beforeEach(reset);

  it("registers the acting agent", () => {
    useStore.getState().ingest(msg());
    expect(useStore.getState().agents["d1/planner/a1"]).toBeTruthy();
  });

  it("registers the recipient agent from a full 'to' id", () => {
    useStore.getState().ingest(msg({ to: "d2/ops/a3" }));
    const agents = useStore.getState().agents;
    expect(agents["d2/ops/a3"]).toMatchObject({ deviceId: "d2", teamId: "ops", agentId: "a3" });
  });

  it("does not create a node for a topic 'to' (no slashes)", () => {
    useStore.getState().ingest(msg({ to: "broadcast" }));
    expect(useStore.getState().agents["broadcast"]).toBeUndefined();
  });
});

describe("store: agent lifecycle", () => {
  beforeEach(reset);

  it("creates an agent node on 'online' before any traffic, with status and role", () => {
    useStore.getState().ingest(agent({ role: "planner" }));
    const node = useStore.getState().agents["d1/planner/a1"];
    expect(node).toBeTruthy();
    expect(node.status).toBe("online");
    expect(node.role).toBe("planner");
    // lifecycle event produces no pulse
    expect(useStore.getState().pulses).toHaveLength(0);
  });

  it("marks the agent offline on 'offline' but keeps the node", () => {
    useStore.getState().ingest(agent({ status: "online" }));
    useStore.getState().ingest(agent({ status: "offline" }));
    const node = useStore.getState().agents["d1/planner/a1"];
    expect(node).toBeTruthy();
    expect(node.status).toBe("offline");
  });

  it("retains role across later traffic events", () => {
    useStore.getState().ingest(agent({ role: "critic" }));
    useStore.getState().ingest(msg()); // a1 sends a message
    const node = useStore.getState().agents["d1/planner/a1"];
    expect(node.role).toBe("critic");
    expect(node.status).toBe("online");
  });
});

describe("store: pulse routing (message direct, blackboard via node)", () => {
  beforeEach(reset);

  it("routes a message pulse directly sender -> recipient (no intermediary)", () => {
    useStore.getState().ingest(msg({ from: "d1/planner/a1", to: "d1/planner/a2" }));
    const p = useStore.getState().pulses[0];
    expect(p.flow).toBe("message");
    expect(p.from).toBe("d1/planner/a1");
    expect(p.to).toBe("d1/planner/a2");
  });

  it("routes a blackboard write as agent -> [blackboard]", () => {
    useStore.getState().ingest(bb({ op: "write", key: "k" }));
    const p = useStore.getState().pulses.at(-1)!;
    expect(p.flow).toBe("bb-write");
    expect(p.to).toBe(BLACKBOARD_ID);
  });

  it("routes a blackboard read as [blackboard] -> agent", () => {
    useStore.getState().ingest(bb({ op: "write", key: "k" }));
    useStore.getState().ingest(bb({ op: "read", key: "k" }));
    const p = useStore.getState().pulses.at(-1)!;
    expect(p.flow).toBe("bb-read");
    expect(p.from).toBe(BLACKBOARD_ID);
    expect(p.to).toBe("d1/planner/a1");
  });

  it("does not create a pulse for to=null (broadcast)", () => {
    useStore.getState().ingest(msg({ to: null }));
    expect(useStore.getState().pulses).toHaveLength(0);
  });

  it("does not create a pulse for agent lifecycle events", () => {
    useStore.getState().ingest(agent());
    expect(useStore.getState().pulses).toHaveLength(0);
  });

  it("expirePulses removes pulses older than the window", () => {
    useStore.getState().ingest(msg());
    const start = useStore.getState().pulses[0].start;
    useStore.getState().expirePulses(start + 2000);
    expect(useStore.getState().pulses).toHaveLength(0);
  });
});

describe("store: edges carry the latest data sent", () => {
  beforeEach(reset);

  it("creates a message edge carrying the body payload", () => {
    useStore.getState().ingest(msg({ from: "d1/planner/a1", to: "d1/planner/a2", msgType: "task", body: { n: 7 } }));
    const edge = Object.values(useStore.getState().edges).find((e) => e.flow === "message")!;
    expect(edge).toBeTruthy();
    expect(edge.from).toBe("d1/planner/a1");
    expect(edge.to).toBe("d1/planner/a2");
    expect(edge.label).toBe("task");
    expect(edge.data).toEqual({ n: 7 });
  });

  it("a blackboard write edge carries the written value", () => {
    useStore.getState().ingest(bb({ op: "write", key: "plan", value: { step: 2 } }));
    const edge = Object.values(useStore.getState().edges).find((e) => e.flow === "bb-write")!;
    expect(edge.to).toBe(BLACKBOARD_ID);
    expect(edge.label).toBe("plan");
    expect(edge.data).toEqual({ step: 2 });
  });

  it("a blackboard read edge carries the stored value back to the agent", () => {
    useStore.getState().ingest(bb({ op: "write", key: "plan", value: { step: 2 } }));
    useStore.getState().ingest(bb({ op: "read", key: "plan" })); // read has no value of its own
    const edge = Object.values(useStore.getState().edges).find((e) => e.flow === "bb-read")!;
    expect(edge.from).toBe(BLACKBOARD_ID);
    expect(edge.to).toBe("d1/planner/a1");
    expect(edge.data).toEqual({ step: 2 }); // resolved from stored value
  });

  it("repeated traffic on the same edge updates data and bumps count (deduped)", () => {
    useStore.getState().ingest(msg({ from: "d1/planner/a1", to: "d1/planner/a2", body: { v: 1 } }));
    useStore.getState().ingest(msg({ from: "d1/planner/a1", to: "d1/planner/a2", body: { v: 2 } }));
    const messageEdges = Object.values(useStore.getState().edges).filter((e) => e.flow === "message");
    expect(messageEdges).toHaveLength(1);
    expect(messageEdges[0].count).toBe(2);
    expect(messageEdges[0].data).toEqual({ v: 2 });
  });

  it("expireEdges drops edges older than the TTL", () => {
    const e = msg({ ts: 1000 });
    useStore.getState().ingest(e);
    expect(Object.keys(useStore.getState().edges).length).toBe(1);
    useStore.getState().expireEdges(1000 + EDGE_TTL_MS + 1);
    expect(Object.keys(useStore.getState().edges).length).toBe(0);
  });
});

describe("store: blackboard", () => {
  beforeEach(reset);

  it("write sets value and version", () => {
    useStore.getState().ingest(bb({ key: "k1", value: { a: 1 }, version: 3 }));
    expect(useStore.getState().blackboard["k1"]).toMatchObject({ value: { a: 1 }, version: 3 });
  });

  it("read increments the read counter without changing value", () => {
    useStore.getState().ingest(bb({ key: "k2", value: { a: 1 } }));
    useStore.getState().ingest(bb({ op: "read", key: "k2" }));
    useStore.getState().ingest(bb({ op: "read", key: "k2" }));
    const entry = useStore.getState().blackboard["k2"];
    expect(entry.reads).toBe(2);
    expect(entry.value).toEqual({ a: 1 });
  });

  it("delete removes the key", () => {
    useStore.getState().ingest(bb({ key: "k3", value: 1 }));
    useStore.getState().ingest(bb({ op: "delete", key: "k3" }));
    expect(useStore.getState().blackboard["k3"]).toBeUndefined();
  });
});

describe("store: events list & pause", () => {
  beforeEach(reset);

  it("prepends newest event first", () => {
    const a = msg();
    const b = msg();
    useStore.getState().ingest(a);
    useStore.getState().ingest(b);
    expect(useStore.getState().events[0].eventId).toBe(b.eventId);
  });

  it("caps stored events at 500", () => {
    for (let i = 0; i < 600; i++) useStore.getState().ingest(msg());
    expect(useStore.getState().events.length).toBe(500);
  });

  it("ignores events while paused", () => {
    useStore.getState().setPaused(true);
    useStore.getState().ingest(msg());
    expect(useStore.getState().events).toHaveLength(0);
    expect(Object.keys(useStore.getState().agents)).toHaveLength(0);
  });

  it("ingestMany applies a batch in order", () => {
    useStore.getState().ingestMany([msg(), msg(), bb()]);
    expect(useStore.getState().events).toHaveLength(3);
    expect(Object.keys(useStore.getState().blackboard)).toHaveLength(1);
  });
});

describe("store: filters & trace selection", () => {
  beforeEach(reset);

  it("setFilter merges partial filter updates", () => {
    useStore.getState().setFilter({ device: "d1" });
    useStore.getState().setFilter({ kind: "message" });
    expect(useStore.getState().filters).toMatchObject({ device: "d1", kind: "message" });
  });

  it("selectTask sets/clears the focused task", () => {
    useStore.getState().selectTask("task-1");
    expect(useStore.getState().selectedTask).toBe("task-1");
    useStore.getState().selectTask(null);
    expect(useStore.getState().selectedTask).toBeNull();
  });
});

describe("store: tasks & scoped snapshot (scalability)", () => {
  beforeEach(reset);

  it("setTasks indexes summaries by id and records the total", () => {
    useStore.getState().setTasks(
      [
        { taskId: "t1", firstTs: 1, lastTs: 9, count: 3, messages: 2, blackboard: 1, devices: ["d1", "d2"], agents: 4 },
        { taskId: "t2", firstTs: 2, lastTs: 5, count: 1, messages: 1, blackboard: 0, devices: ["d1"], agents: 1 },
      ],
      57
    );
    expect(Object.keys(useStore.getState().tasks).sort()).toEqual(["t1", "t2"]);
    expect(useStore.getState().tasks["t1"].devices).toEqual(["d1", "d2"]);
    expect(useStore.getState().tasksTotal).toBe(57);
  });

  it("selectTask clears task-scoped derived state and calls subscribe", () => {
    const calls: (string | null)[] = [];
    useStore.getState().setSubscribe((id) => calls.push(id));
    useStore.getState().ingest(msg()); // create an edge/pulse/event
    expect(Object.keys(useStore.getState().edges).length).toBeGreaterThan(0);
    useStore.getState().selectTask("task-x");
    expect(calls).toEqual(["task-x"]);
    expect(useStore.getState().edges).toEqual({});
    expect(useStore.getState().events).toEqual([]);
  });

  it("loadSnapshot replaces flows but keeps agent presence", () => {
    useStore.getState().ingest(msg({ from: "d1/planner/a1", to: "d1/planner/a2", body: { old: 1 } }));
    // snapshot: presence + a fresh task flow
    useStore.getState().loadSnapshot([agent({ agentId: "a1", role: "leader" }), msg({ body: { fresh: 1 } })]);
    const edges = Object.values(useStore.getState().edges);
    expect(edges).toHaveLength(1);
    expect(edges[0].data).toEqual({ fresh: 1 });
    expect(useStore.getState().agents["d1/planner/a1"].role).toBe("leader");
  });
});

describe("store: workspaces (isolation)", () => {
  beforeEach(reset);

  it("setSpaces records the workspace directory", () => {
    useStore.getState().setSpaces([
      { space: "alice", agents: 10, tasks: 3, lastTs: 5 },
      { space: "bob", agents: 4, tasks: 1, lastTs: 9 },
    ]);
    expect(useStore.getState().spaces.map((s) => s.space)).toEqual(["alice", "bob"]);
  });

  it("joinSpace switches workspace, calls join(), and clears ALL prior state incl. agents", () => {
    const joined: string[] = [];
    useStore.getState().setJoin((sp) => joined.push(sp));
    // populate some state in the current workspace
    useStore.getState().ingest(agent({ agentId: "a1" }));
    useStore.getState().ingest(msg());
    useStore.getState().setTasks([{ taskId: "t1", firstTs: 1, lastTs: 1, count: 1, messages: 1, blackboard: 0, devices: ["d1"], agents: 1 }], 1);

    useStore.getState().joinSpace("bob");

    expect(joined).toEqual(["bob"]);
    const s = useStore.getState();
    expect(s.space).toBe("bob");
    expect(s.agents).toEqual({}); // presence is per-space → cleared
    expect(s.edges).toEqual({});
    expect(s.events).toEqual([]);
    expect(s.tasks).toEqual({});
    expect(s.selectedTask).toBeNull();
  });
});

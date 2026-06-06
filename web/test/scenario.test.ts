import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/store";
import type { FlowEvent } from "../src/types";
import { BLACKBOARD_ID } from "../src/types";

// The concrete topology requested:
//   device-A: team alpha (4: lead=comm + 3 workers), team beta (2: lead=leader + 1 worker)
//   device-B: team gamma (4: lead=comm + 3 workers)
//   - one comm agent per device; workers act through their team leader;
//     only comm agents talk across devices.
type Role = "comm" | "leader" | "worker";
interface Spec {
  device: string;
  team: string;
  agent: string;
  role: Role;
  reportsTo?: string;
}
const devA = "device-A";
const devB = "device-B";
const fid = (d: string, t: string, a: string) => `${d}/${t}/${a}`;

const AGENTS: Spec[] = [
  { device: devA, team: "alpha", agent: "lead", role: "comm" },
  { device: devA, team: "alpha", agent: "w1", role: "worker", reportsTo: fid(devA, "alpha", "lead") },
  { device: devA, team: "alpha", agent: "w2", role: "worker", reportsTo: fid(devA, "alpha", "lead") },
  { device: devA, team: "alpha", agent: "w3", role: "worker", reportsTo: fid(devA, "alpha", "lead") },
  { device: devA, team: "beta", agent: "lead", role: "leader", reportsTo: fid(devA, "alpha", "lead") },
  { device: devA, team: "beta", agent: "w1", role: "worker", reportsTo: fid(devA, "beta", "lead") },
  { device: devB, team: "gamma", agent: "lead", role: "comm" },
  { device: devB, team: "gamma", agent: "w1", role: "worker", reportsTo: fid(devB, "gamma", "lead") },
  { device: devB, team: "gamma", agent: "w2", role: "worker", reportsTo: fid(devB, "gamma", "lead") },
  { device: devB, team: "gamma", agent: "w3", role: "worker", reportsTo: fid(devB, "gamma", "lead") },
];

let seq = 0;
function reg(s: Spec): FlowEvent {
  return {
    kind: "agent",
    eventId: "ag" + seq++,
    ts: 1000 + seq,
    deviceId: s.device,
    teamId: s.team,
    agentId: s.agent,
    status: "online",
    role: s.role,
  };
}
function msg(from: Spec, to: string, body: unknown): FlowEvent {
  return {
    kind: "message",
    eventId: "m" + seq++,
    ts: 1000 + seq,
    deviceId: from.device,
    teamId: from.team,
    agentId: from.agent,
    from: fid(from.device, from.team, from.agent),
    to,
    op: "send",
    msgType: "task",
    body,
  };
}
function bbWrite(by: Spec, key: string, value: unknown): FlowEvent {
  return {
    kind: "blackboard",
    eventId: "b" + seq++,
    ts: 1000 + seq,
    deviceId: by.device,
    teamId: by.team,
    agentId: by.agent,
    op: "write",
    key,
    value,
  };
}
const get = (d: string, t: string, a: string) => AGENTS.find((s) => s.device === d && s.team === t && s.agent === a)!;

function reset() {
  useStore.setState({
    connected: false, paused: false, rate: 0, events: [], agents: {}, blackboard: {},
    pulses: [], edges: {}, tasks: {}, tasksTotal: 0, selectedTask: null,
    filters: { device: null, team: null, kind: "all", text: "" },
  });
}

function loadTopology() {
  useStore.getState().ingestMany(AGENTS.map(reg));
}

describe("scenario: 2 devices / teams 2+1 / agents 4+2 and 4", () => {
  beforeEach(() => {
    reset();
    seq = 0;
  });

  it("registers exactly 2 devices", () => {
    loadTopology();
    const devices = new Set(Object.values(useStore.getState().agents).map((a) => a.deviceId));
    expect([...devices].sort()).toEqual([devA, devB]);
  });

  it("device-A has 2 teams, device-B has 1 team", () => {
    loadTopology();
    const agents = Object.values(useStore.getState().agents);
    const teamsOf = (d: string) => new Set(agents.filter((a) => a.deviceId === d).map((a) => a.teamId));
    expect([...teamsOf(devA)].sort()).toEqual(["alpha", "beta"]);
    expect([...teamsOf(devB)]).toEqual(["gamma"]);
  });

  it("teams have 4, 2 and 4 agents (device-A: 4+2, device-B: 4)", () => {
    loadTopology();
    const agents = Object.values(useStore.getState().agents);
    const count = (t: string) => agents.filter((a) => a.teamId === t).length;
    expect(count("alpha")).toBe(4);
    expect(count("beta")).toBe(2);
    expect(count("gamma")).toBe(4);
    expect(agents).toHaveLength(10);
  });

  it("has exactly one comm (통신) agent per device", () => {
    loadTopology();
    const agents = Object.values(useStore.getState().agents);
    const commByDevice = (d: string) => agents.filter((a) => a.deviceId === d && a.role === "comm");
    expect(commByDevice(devA).map((a) => a.id)).toEqual([fid(devA, "alpha", "lead")]);
    expect(commByDevice(devB).map((a) => a.id)).toEqual([fid(devB, "gamma", "lead")]);
  });

  it("every team has exactly one coordinator (통솔자: leader or comm)", () => {
    loadTopology();
    const agents = Object.values(useStore.getState().agents);
    for (const team of ["alpha", "beta", "gamma"]) {
      const coords = agents.filter((a) => a.teamId === team && (a.role === "leader" || a.role === "comm"));
      expect(coords).toHaveLength(1);
    }
  });
});

describe("scenario: flow routes through leader and comm agents", () => {
  beforeEach(() => {
    reset();
    seq = 0;
    loadTopology();
  });

  it("a worker acts through its team leader (edge worker -> leader)", () => {
    const w = get(devA, "alpha", "w1");
    useStore.getState().ingest(msg(w, w.reportsTo!, { task: "rank" }));
    const edge = Object.values(useStore.getState().edges).find(
      (e) => e.flow === "message" && e.from === fid(devA, "alpha", "w1") && e.to === fid(devA, "alpha", "lead")
    );
    expect(edge).toBeTruthy();
    expect(edge!.data).toEqual({ task: "rank" });
  });

  it("a sub-team leader escalates to the device comm agent", () => {
    const betaLead = get(devA, "beta", "lead");
    useStore.getState().ingest(msg(betaLead, betaLead.reportsTo!, { report: 1 }));
    const edge = Object.values(useStore.getState().edges).find(
      (e) => e.from === fid(devA, "beta", "lead") && e.to === fid(devA, "alpha", "lead")
    );
    expect(edge).toBeTruthy();
  });

  it("cross-device traffic goes only between the two comm agents", () => {
    const ca = get(devA, "alpha", "lead");
    const cb = get(devB, "gamma", "lead");
    useStore.getState().ingest(msg(ca, fid(cb.device, cb.team, cb.agent), { sync: true }));
    const edge = Object.values(useStore.getState().edges).find(
      (e) => e.from === fid(devA, "alpha", "lead") && e.to === fid(devB, "gamma", "lead")
    );
    expect(edge).toBeTruthy();
    // both endpoints are comm agents
    const agents = useStore.getState().agents;
    expect(agents[edge!.from].role).toBe("comm");
    expect(agents[edge!.to].role).toBe("comm");
  });

  it("a leader writes its result through the Blackboard node", () => {
    const betaLead = get(devA, "beta", "lead");
    useStore.getState().ingest(bbWrite(betaLead, "bb:beta:result", { score: 0.9 }));
    const edge = Object.values(useStore.getState().edges).find((e) => e.flow === "bb-write");
    expect(edge!.to).toBe(BLACKBOARD_ID);
    expect(edge!.data).toEqual({ score: 0.9 });
  });
});

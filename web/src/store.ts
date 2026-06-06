import { create } from "zustand";
import type { FlowEvent, TaskSummary } from "./types";
import { BLACKBOARD_ID } from "./types";

export type AgentStatus = "online" | "offline";

export interface AgentNode {
  id: string; // full id "device/team/agent"
  deviceId: string;
  teamId: string;
  agentId: string;
  status: AgentStatus;
  role?: string;
  lastSeen: number;
}

export type PulseFlow = "message" | "bb-write" | "bb-read";

export interface MessagePulse {
  id: string;
  from: string;
  to: string;
  flow: PulseFlow;
  start: number; // performance.now() when created
}

/** A persistent (recently-active) connection between two nodes, carrying the
 *  latest data sent over it. Shown as a labeled edge in the topology. */
export interface EdgeState {
  id: string;
  from: string;
  to: string;
  flow: PulseFlow;
  label?: string; // msgType (message) or key (blackboard)
  data?: unknown; // body (message) or value (blackboard)
  ts: number; // last activity (event wall-clock ts)
  count: number;
}

export interface Filters {
  device: string | null;
  team: string | null;
  kind: "all" | "message" | "blackboard" | "agent";
  text: string;
}

export type SubscribeFn = (taskId: string | null) => void;

const MAX_EVENTS = 500;
const MAX_PULSES = 120;
export const EDGE_TTL_MS = 6000;

interface State {
  connected: boolean;
  paused: boolean;
  rate: number;
  showEdgeData: boolean;
  events: FlowEvent[]; // newest first
  agents: Record<string, AgentNode>;
  blackboard: Record<string, { value: unknown; version?: number; by: string; ts: number; reads: number }>;
  pulses: MessagePulse[];
  edges: Record<string, EdgeState>;
  tasks: Record<string, TaskSummary>;
  tasksTotal: number;
  selectedTask: string | null;
  filters: Filters;

  /** Set by the ws layer; lets selectTask tell the server what to stream. */
  subscribe: SubscribeFn;

  setConnected: (c: boolean) => void;
  setPaused: (p: boolean) => void;
  setRate: (r: number) => void;
  setShowEdgeData: (v: boolean) => void;
  setFilter: (f: Partial<Filters>) => void;
  setTasks: (tasks: TaskSummary[], total: number) => void;
  setSubscribe: (fn: SubscribeFn) => void;
  selectTask: (t: string | null) => void;
  ingest: (e: FlowEvent) => void;
  ingestMany: (es: FlowEvent[]) => void;
  /** Replace all task-scoped derived state from a fresh server snapshot. */
  loadSnapshot: (events: FlowEvent[]) => void;
  expirePulses: (now: number) => void;
  expireEdges: (now: number) => void;
}

function nodeId(e: FlowEvent): string {
  return `${e.deviceId}/${e.teamId}/${e.agentId}`;
}

let pulseSeq = 0;
function addPulse(list: MessagePulse[], p: Omit<MessagePulse, "id" | "start">): MessagePulse[] {
  pulseSeq++;
  const next = [...list, { ...p, id: `p${pulseSeq}`, start: performance.now() }];
  return next.length > MAX_PULSES ? next.slice(next.length - MAX_PULSES) : next;
}

function edgeKey(from: string, to: string, flow: PulseFlow): string {
  return `${from}->${to}:${flow}`;
}

function upsertEdge(
  edges: Record<string, EdgeState>,
  e: { from: string; to: string; flow: PulseFlow; label?: string; data?: unknown; ts: number }
): Record<string, EdgeState> {
  const id = edgeKey(e.from, e.to, e.flow);
  const prev = edges[id];
  return {
    ...edges,
    [id]: {
      id,
      from: e.from,
      to: e.to,
      flow: e.flow,
      label: e.label,
      data: e.data,
      ts: e.ts,
      count: (prev?.count ?? 0) + 1,
    },
  };
}

export const useStore = create<State>((set) => ({
  connected: false,
  paused: false,
  rate: 0,
  showEdgeData: true,
  events: [],
  agents: {},
  blackboard: {},
  pulses: [],
  edges: {},
  tasks: {},
  tasksTotal: 0,
  selectedTask: null,
  filters: { device: null, team: null, kind: "all", text: "" },
  subscribe: () => {},

  setConnected: (c) => set({ connected: c }),
  setPaused: (p) => set({ paused: p }),
  setRate: (r) => set({ rate: r }),
  setShowEdgeData: (v) => set({ showEdgeData: v }),
  setFilter: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  setTasks: (tasks, total) =>
    set(() => {
      const map: Record<string, TaskSummary> = {};
      for (const t of tasks) map[t.taskId] = t;
      return { tasks: map, tasksTotal: total };
    }),
  setSubscribe: (fn) => set({ subscribe: fn }),
  selectTask: (t) =>
    set((s) => {
      s.subscribe(t); // tell the server to (un)stream this task's detail
      // clear task-scoped derived state immediately; snapshot will repopulate
      return { selectedTask: t, edges: {}, pulses: [], events: [], blackboard: {} };
    }),

  ingest: (e) => set((s) => applyEvent(s, e)),
  ingestMany: (es) => set((s) => es.reduce((acc, e) => applyEvent(acc, e), s)),
  loadSnapshot: (es) =>
    set((s) => {
      const base: State = { ...s, edges: {}, pulses: [], events: [], blackboard: {} };
      return es.reduce((acc, e) => applyEvent(acc, e), base);
    }),

  expirePulses: (now) =>
    set((s) => {
      const alive = s.pulses.filter((p) => now - p.start < 1100);
      return alive.length === s.pulses.length ? s : { pulses: alive };
    }),

  expireEdges: (now) =>
    set((s) => {
      let changed = false;
      const next: Record<string, EdgeState> = {};
      for (const [k, edge] of Object.entries(s.edges)) {
        if (now - edge.ts < EDGE_TTL_MS) next[k] = edge;
        else changed = true;
      }
      return changed ? { edges: next } : s;
    }),
}));

function applyEvent(s: State, e: FlowEvent): State {
  if (s.paused) return s;

  const agents = { ...s.agents };
  const aid = nodeId(e);

  // register / refresh the acting agent
  const prev = agents[aid];
  const status: AgentStatus = e.kind === "agent" ? e.status : "online";
  agents[aid] = {
    id: aid,
    deviceId: e.deviceId,
    teamId: e.teamId,
    agentId: e.agentId,
    status,
    role: e.kind === "agent" && e.role ? e.role : prev?.role,
    lastSeen: e.ts,
  };

  let blackboard = s.blackboard;
  let pulses = s.pulses;
  let edges = s.edges;

  if (e.kind === "message") {
    // ensure recipient node exists when it's a full id
    if (e.to && e.to.includes("/")) {
      const [d, t, a] = e.to.split("/");
      if (d && t && a && !agents[e.to]) {
        agents[e.to] = { id: e.to, deviceId: d, teamId: t, agentId: a, status: "online", lastSeen: e.ts };
      }
    }
    if (e.to) {
      // direct agent -> agent edge
      pulses = addPulse(pulses, { from: aid, to: e.to, flow: "message" });
      edges = upsertEdge(edges, { from: aid, to: e.to, flow: "message", label: e.msgType, data: e.body, ts: e.ts });
    }
  } else if (e.kind === "blackboard") {
    blackboard = { ...s.blackboard };
    const cur = blackboard[e.key] ?? { value: undefined, by: aid, ts: e.ts, reads: 0 };
    if (e.op === "write" || e.op === "update") {
      blackboard[e.key] = { value: e.value, version: e.version, by: aid, ts: e.ts, reads: cur.reads };
      pulses = addPulse(pulses, { from: aid, to: BLACKBOARD_ID, flow: "bb-write" });
      edges = upsertEdge(edges, { from: aid, to: BLACKBOARD_ID, flow: "bb-write", label: e.key, data: e.value, ts: e.ts });
    } else if (e.op === "read") {
      blackboard[e.key] = { ...cur, reads: cur.reads + 1, ts: e.ts };
      pulses = addPulse(pulses, { from: BLACKBOARD_ID, to: aid, flow: "bb-read" });
      // the data "read" is the current stored value
      edges = upsertEdge(edges, { from: BLACKBOARD_ID, to: aid, flow: "bb-read", label: e.key, data: cur.value, ts: e.ts });
    } else if (e.op === "delete") {
      delete blackboard[e.key];
      pulses = addPulse(pulses, { from: aid, to: BLACKBOARD_ID, flow: "bb-write" });
      edges = upsertEdge(edges, { from: aid, to: BLACKBOARD_ID, flow: "bb-write", label: e.key + " (del)", ts: e.ts });
    }
  }
  // kind === "agent": presence only, no pulse/edge

  const events = [e, ...s.events];
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  return { ...s, agents, blackboard, pulses, edges, events };
}

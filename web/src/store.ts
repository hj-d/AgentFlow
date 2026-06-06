import { create } from "zustand";
import type { FlowEvent, TaskSummary, SpaceSummary, ClientControl } from "./types";
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
export type JoinFn = (space: string) => void;
export type ControlFn = (msg: ClientControl) => void;

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
  /** Becomes true after the first blackboard event in the current space, so the
   *  Topology can reveal the Blackboard backbone node only once it's actually used. */
  bbSeen: boolean;
  selectedTask: string | null;
  space: string; // current workspace being viewed
  spaces: SpaceSummary[]; // directory of active workspaces
  filters: Filters;

  /** Set by the ws layer; lets selectTask/joinSpace/delete talk to the server. */
  subscribe: SubscribeFn;
  join: JoinFn;
  control: ControlFn;

  setConnected: (c: boolean) => void;
  setPaused: (p: boolean) => void;
  setRate: (r: number) => void;
  setShowEdgeData: (v: boolean) => void;
  setFilter: (f: Partial<Filters>) => void;
  setTasks: (tasks: TaskSummary[], total: number) => void;
  setSpaces: (spaces: SpaceSummary[]) => void;
  setSubscribe: (fn: SubscribeFn) => void;
  setJoin: (fn: JoinFn) => void;
  setControl: (fn: ControlFn) => void;
  selectTask: (t: string | null) => void;
  joinSpace: (space: string) => void;
  /** Delete one task (server + local). */
  deleteTask: (taskId: string) => void;
  /** Clear all tasks/events in the current space (keeps the agent roster). */
  clearSpace: () => void;
  /** Delete an entire workspace from the directory. */
  deleteSpace: (space: string) => void;
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
  bbSeen: false,
  selectedTask: null,
  space: "default",
  spaces: [],
  filters: { device: null, team: null, kind: "all", text: "" },
  subscribe: () => {},
  join: () => {},
  control: () => {},

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
  setSpaces: (spaces) => set({ spaces }),
  setSubscribe: (fn) => set({ subscribe: fn }),
  setJoin: (fn) => set({ join: fn }),
  setControl: (fn) => set({ control: fn }),
  selectTask: (t) =>
    set((s) => {
      s.subscribe(t); // tell the server to (un)stream this task's detail
      // clear task-scoped derived state immediately; snapshot will repopulate
      return { selectedTask: t, edges: {}, pulses: [], events: [], blackboard: {}, bbSeen: false };
    }),
  joinSpace: (sp) =>
    set((s) => {
      s.join(sp); // tell the server to switch workspace
      // workspace switch clears EVERYTHING (presence is per-space); snapshot repopulates
      return {
        space: sp,
        selectedTask: null,
        agents: {},
        edges: {},
        pulses: [],
        events: [],
        blackboard: {},
        bbSeen: false,
        tasks: {},
        tasksTotal: 0,
      };
    }),

  deleteTask: (taskId) =>
    set((s) => {
      s.control({ type: "deleteTask", taskId });
      const tasks = { ...s.tasks };
      const existed = taskId in tasks;
      delete tasks[taskId];
      const wasSelected = s.selectedTask === taskId;
      return {
        tasks,
        tasksTotal: Math.max(0, s.tasksTotal - (existed ? 1 : 0)),
        // if the deleted task was focused, drop back to the all-tasks view
        ...(wasSelected ? { selectedTask: null, edges: {}, pulses: [], events: [], blackboard: {}, bbSeen: false } : {}),
      };
    }),
  clearSpace: () =>
    set((s) => {
      s.control({ type: "clearSpace" });
      // keep agents (presence is re-sent by the server snapshot); drop everything task-scoped
      return { tasks: {}, tasksTotal: 0, selectedTask: null, edges: {}, pulses: [], events: [], blackboard: {}, bbSeen: false };
    }),
  deleteSpace: (space) =>
    set((s) => {
      s.control({ type: "deleteSpace", space });
      return { spaces: s.spaces.filter((x) => x.space !== space) };
    }),

  ingest: (e) => set((s) => applyEvent(s, e)),
  ingestMany: (es) => set((s) => es.reduce((acc, e) => applyEvent(acc, e), s)),
  loadSnapshot: (es) =>
    set((s) => {
      const base: State = { ...s, edges: {}, pulses: [], events: [], blackboard: {}, bbSeen: false };
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

  // reveal the Blackboard backbone node only once the blackboard is actually used
  const bbSeen = s.bbSeen || e.kind === "blackboard";

  return { ...s, agents, blackboard, pulses, edges, events, bbSeen };
}

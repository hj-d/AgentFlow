import { create } from "zustand";
import type { FlowEvent, TaskSummary, SpaceSummary, ClientControl } from "./types";

// ---- agent node ----
export interface AgentNode {
  id: string;           // "hub" | "pc" | "tv"
  agentId: string;
  phase: "start" | "end";
  role?: string;
  label?: string;
  lastSeen: number;
  activity?: { tool: string; ts: number; phase: "start" | "end" };
}

// ---- delegate log entry ----
export interface DelegateEntry {
  id: string;
  eventId: string;
  ts: number;
  phase: "dispatch" | "return";
  from: string;
  to: string;
  task?: string;
  payload?: unknown;
  taskId?: string;
}

// ---- noti entry ----
export interface NotiEntry {
  id: string;
  eventId: string;
  ts: number;
  phase: "broadcast" | "ack";
  from: string;
  to: string | string[];
  key?: string;
  message?: string;
  taskId?: string;
}

// ---- current task I/O ----
export interface TaskIO {
  taskId: string;
  scenario?: string;
  request?: string;
  result?: unknown;
  inputTs?: number;
  outputTs?: number;
}

// ---- pulse / edge ----
export type PulseFlow = "delegate" | "bb-write" | "bb-read" | "noti";

export interface Pulse {
  id: string;
  from: string;
  to: string;
  flow: PulseFlow;
  start: number;
}

export interface EdgeState {
  id: string;
  from: string;
  to: string;
  flow: PulseFlow;
  label?: string;
  data?: unknown;
  ts: number;
  count: number;
}

export const EDGE_TTL_MS = 5000;
export const ACTIVITY_TTL_MS = 5000;
const MAX_REPLAY = 40;
export const REPLAY_INTERVAL_MS = 250;
const MAX_EVENTS = 400;
const MAX_PULSES = 80;
const MAX_DELEGATE_LOG = 100;
const MAX_NOTI_LOG = 50;

export type SubscribeFn = (taskId: string | null) => void;
export type JoinFn = (space: string) => void;
export type ControlFn = (msg: ClientControl) => void;

interface State {
  connected: boolean;
  paused: boolean;
  rate: number;
  events: FlowEvent[];
  replayQueue: FlowEvent[];
  agents: Record<string, AgentNode>;
  blackboard: Record<string, { value: unknown; by: string; ts: number; reads: number }>;
  delegateLog: DelegateEntry[];
  notiLog: NotiEntry[];
  taskIO: TaskIO | null;
  pulses: Pulse[];
  edges: Record<string, EdgeState>;
  tasks: Record<string, TaskSummary>;
  tasksTotal: number;
  bbSeen: boolean;
  selectedTask: string | null;
  space: string;
  spaces: SpaceSummary[];
  activeTab: "blackboard" | "notis" | "events" | "tasks";

  subscribe: SubscribeFn;
  join: JoinFn;
  control: ControlFn;

  setConnected: (c: boolean) => void;
  setPaused: (p: boolean) => void;
  setRate: (r: number) => void;
  setActiveTab: (t: "blackboard" | "notis" | "events" | "tasks") => void;
  setTasks: (tasks: TaskSummary[], total: number) => void;
  setSpaces: (spaces: SpaceSummary[]) => void;
  setSubscribe: (fn: SubscribeFn) => void;
  setJoin: (fn: JoinFn) => void;
  setControl: (fn: ControlFn) => void;
  selectTask: (t: string | null) => void;
  joinSpace: (space: string) => void;
  deleteTask: (taskId: string) => void;
  clearSpace: () => void;
  deleteSpace: (space: string) => void;
  ingest: (e: FlowEvent) => void;
  ingestMany: (es: FlowEvent[]) => void;
  loadSnapshot: (events: FlowEvent[]) => void;
  replayNext: () => void;
  expirePulses: (now: number) => void;
  expireEdges: (now: number) => void;
  expireActivity: (now: number) => void;
}

let pulseSeq = 0;
function addPulse(list: Pulse[], p: Omit<Pulse, "id" | "start">): Pulse[] {
  pulseSeq++;
  const next = [...list, { ...p, id: `p${pulseSeq}`, start: performance.now() }];
  return next.length > MAX_PULSES ? next.slice(next.length - MAX_PULSES) : next;
}

function edgeKey(from: string, to: string, flow: PulseFlow): string {
  return `${from}→${to}:${flow}`;
}

function upsertEdge(
  edges: Record<string, EdgeState>,
  e: { from: string; to: string; flow: PulseFlow; label?: string; data?: unknown; ts: number }
): Record<string, EdgeState> {
  const id = edgeKey(e.from, e.to, e.flow);
  const prev = edges[id];
  return { ...edges, [id]: { id, from: e.from, to: e.to, flow: e.flow, label: e.label, data: e.data, ts: e.ts, count: (prev?.count ?? 0) + 1 } };
}

const emptyState = (): Partial<State> => ({
  events: [],
  replayQueue: [],
  agents: {},
  blackboard: {},
  delegateLog: [],
  notiLog: [],
  taskIO: null,
  pulses: [],
  edges: {},
  bbSeen: false,
  selectedTask: null,
});

export const useStore = create<State>((set) => ({
  connected: false,
  paused: false,
  rate: 0,
  events: [],
  replayQueue: [],
  agents: {},
  blackboard: {},
  delegateLog: [],
  notiLog: [],
  taskIO: null,
  pulses: [],
  edges: {},
  bbSeen: false,
  selectedTask: null,
  tasks: {},
  tasksTotal: 0,
  space: "default",
  spaces: [],
  activeTab: "blackboard",
  subscribe: () => {},
  join: () => {},
  control: () => {},

  setConnected: (c) => set({ connected: c }),
  setPaused: (p) => set({ paused: p }),
  setRate: (r) => set({ rate: r }),
  setActiveTab: (t) => set({ activeTab: t }),
  setTasks: (tasks, total) => set(() => {
    const map: Record<string, TaskSummary> = {};
    for (const t of tasks) map[t.taskId] = t;
    return { tasks: map, tasksTotal: total };
  }),
  setSpaces: (spaces) => set({ spaces }),
  setSubscribe: (fn) => set({ subscribe: fn }),
  setJoin: (fn) => set({ join: fn }),
  setControl: (fn) => set({ control: fn }),

  selectTask: (t) => set((s) => {
    s.subscribe(t);
    return { selectedTask: t, ...emptyState() };
  }),
  joinSpace: (sp) => set((s) => {
    s.join(sp);
    return { space: sp, tasks: {}, tasksTotal: 0, ...emptyState() };
  }),
  deleteTask: (taskId) => set((s) => {
    s.control({ type: "deleteTask", taskId });
    const tasks = { ...s.tasks };
    const existed = taskId in tasks;
    delete tasks[taskId];
    const wasSelected = s.selectedTask === taskId;
    return { tasks, tasksTotal: Math.max(0, s.tasksTotal - (existed ? 1 : 0)), ...(wasSelected ? emptyState() : {}) };
  }),
  clearSpace: () => set((s) => {
    s.control({ type: "clearSpace" });
    return { tasks: {}, tasksTotal: 0, ...emptyState() };
  }),
  deleteSpace: (space) => set((s) => {
    s.control({ type: "deleteSpace", space });
    return { spaces: s.spaces.filter((x) => x.space !== space) };
  }),

  ingest: (e) => set((s) => s.replayQueue.length ? { replayQueue: [...s.replayQueue, e] } : applyEvent(s, e)),
  ingestMany: (es) => set((s) => es.reduce((acc, e) => applyEvent(acc, e), s)),
  loadSnapshot: (es) => set((s) => {
    const base: State = { ...s, ...emptyState() } as State;
    const split = Math.max(0, es.length - MAX_REPLAY);
    const backdrop = es.slice(0, split).reduce((acc, e) => applyEvent(acc, e), base);
    return { ...backdrop, replayQueue: es.slice(split) };
  }),
  replayNext: () => set((s) => {
    if (s.paused || !s.replayQueue.length) return s;
    const [head, ...rest] = s.replayQueue;
    return { ...applyEvent(s, head), replayQueue: rest };
  }),

  expirePulses: (now) => set((s) => {
    const alive = s.pulses.filter((p) => now - p.start < 1100);
    return alive.length === s.pulses.length ? s : { pulses: alive };
  }),
  expireEdges: (now) => set((s) => {
    let changed = false;
    const next: Record<string, EdgeState> = {};
    for (const [k, edge] of Object.entries(s.edges)) {
      if (now - edge.ts < EDGE_TTL_MS) next[k] = edge;
      else changed = true;
    }
    return changed ? { edges: next } : s;
  }),
  expireActivity: (now) => set((s) => {
    let changed = false;
    const agents: Record<string, AgentNode> = {};
    for (const [id, a] of Object.entries(s.agents)) {
      if (a.activity && a.activity.phase === "start" && now - a.activity.ts >= ACTIVITY_TTL_MS) {
        agents[id] = { ...a, activity: undefined };
        changed = true;
      } else {
        agents[id] = a;
      }
    }
    return changed ? { agents } : s;
  }),
}));

function applyEvent(s: State, e: FlowEvent): State {
  if (s.paused) return s;

  const agents = { ...s.agents };
  const aid = e.agentId;
  const prev = agents[aid];

  // register / refresh agent
  if (e.kind === "agent") {
    agents[aid] = {
      id: aid,
      agentId: aid,
      phase: e.phase,
      role: e.role ?? prev?.role,
      label: e.label ?? prev?.label,
      lastSeen: e.ts,
      activity: prev?.activity,
    };
  } else {
    if (!agents[aid]) {
      agents[aid] = { id: aid, agentId: aid, phase: "start", lastSeen: e.ts };
    } else {
      agents[aid] = { ...agents[aid], lastSeen: e.ts };
    }
  }

  // ensure delegate target agent exists
  if (e.kind === "delegate") {
    const target = e.phase === "dispatch" ? e.to : e.from;
    if (!agents[target]) agents[target] = { id: target, agentId: target, phase: "start", lastSeen: e.ts };
  }
  // ensure noti target agents exist
  if (e.kind === "noti") {
    const targets = Array.isArray(e.to) ? e.to : [e.to];
    for (const t of targets) {
      if (!agents[t]) agents[t] = { id: t, agentId: t, phase: "start", lastSeen: e.ts };
    }
  }

  let blackboard = s.blackboard;
  let pulses = s.pulses;
  let edges = s.edges;
  let delegateLog = s.delegateLog;
  let notiLog = s.notiLog;
  let taskIO = s.taskIO;
  let bbSeen = s.bbSeen;

  if (e.kind === "tool") {
    agents[aid] = {
      ...agents[aid],
      activity: e.phase === "end" ? undefined : { tool: e.tool, ts: e.ts, phase: "start" },
    };
  }

  if (e.kind === "delegate") {
    const entry: DelegateEntry = {
      id: e.eventId,
      eventId: e.eventId,
      ts: e.ts,
      phase: e.phase,
      from: e.from,
      to: e.to,
      task: e.task,
      payload: e.payload,
      taskId: e.taskId,
    };
    delegateLog = [entry, ...delegateLog].slice(0, MAX_DELEGATE_LOG);
    pulses = addPulse(pulses, { from: e.from, to: e.to, flow: "delegate" });
    edges = upsertEdge(edges, { from: e.from, to: e.to, flow: "delegate", label: e.task ?? e.phase, data: e.payload, ts: e.ts });
  }

  if (e.kind === "blackboard") {
    blackboard = { ...s.blackboard };
    const cur = blackboard[e.key] ?? { value: undefined, by: aid, ts: e.ts, reads: 0 };
    if (e.op === "write") {
      blackboard[e.key] = { value: e.value, by: aid, ts: e.ts, reads: cur.reads };
      pulses = addPulse(pulses, { from: aid, to: "__blackboard__", flow: "bb-write" });
      edges = upsertEdge(edges, { from: aid, to: "__blackboard__", flow: "bb-write", label: e.key, data: e.value, ts: e.ts });
    } else {
      blackboard[e.key] = { ...cur, reads: cur.reads + 1, ts: e.ts };
      pulses = addPulse(pulses, { from: "__blackboard__", to: aid, flow: "bb-read" });
      edges = upsertEdge(edges, { from: "__blackboard__", to: aid, flow: "bb-read", label: e.key, data: cur.value, ts: e.ts });
    }
    bbSeen = true;
  }

  if (e.kind === "noti") {
    const entry: NotiEntry = {
      id: e.eventId,
      eventId: e.eventId,
      ts: e.ts,
      phase: e.phase,
      from: e.from,
      to: e.to,
      key: e.key,
      message: e.message,
      taskId: e.taskId,
    };
    notiLog = [entry, ...notiLog].slice(0, MAX_NOTI_LOG);
    const targets = Array.isArray(e.to) ? e.to : [e.to];
    for (const t of targets) {
      pulses = addPulse(pulses, { from: e.from, to: t, flow: "noti" });
      edges = upsertEdge(edges, { from: e.from, to: t, flow: "noti", label: e.phase, data: e.message, ts: e.ts });
    }
  }

  if (e.kind === "task") {
    if (e.phase === "input") {
      taskIO = { taskId: e.taskId ?? "", scenario: e.scenario, request: e.request, inputTs: e.ts };
    } else if (e.phase === "output") {
      taskIO = taskIO
        ? { ...taskIO, result: e.result, outputTs: e.ts }
        : { taskId: e.taskId ?? "", scenario: e.scenario, result: e.result, outputTs: e.ts };
    }
  }

  const events = [e, ...s.events];
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  return { ...s, agents, blackboard, pulses, edges, delegateLog, notiLog, taskIO, events, bbSeen };
}

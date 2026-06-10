// AgentFlow — unified flow-event model.
// 6 event kinds: agent · tool · delegate · blackboard · noti · task

export const BLACKBOARD_ID = "__blackboard__";
export const DEFAULT_SPACE = "default";

export interface FlowEventBase {
  eventId: string;
  ts: number;
  space?: string;
  agentId: string;
  taskId?: string;
  traceId?: string;
  causedBy?: string;
}

// Agent lifecycle — start when agent comes online, end when it goes offline.
export interface AgentEvent extends FlowEventBase {
  kind: "agent";
  phase: "start" | "end";
  role?: string;
  label?: string;
}

// Tool invocation — start marks the agent busy, end releases it.
export interface ToolEvent extends FlowEventBase {
  kind: "tool";
  tool: string;
  phase: "start" | "end";
  status?: "ok" | "error";
  input?: unknown;
  output?: unknown;
  summary?: string;
}

// Inter-agent delegation — dispatch sends work to another agent, return brings results back.
export interface DelegateEvent extends FlowEventBase {
  kind: "delegate";
  phase: "dispatch" | "return";
  from: string;
  to: string;
  task?: string;
  payload?: unknown;
}

// Shared blackboard — read/write the key-value store shared across agents.
export interface BlackboardEvent extends FlowEventBase {
  kind: "blackboard";
  op: "read" | "write";
  key: string;
  value?: unknown;
}

// Noti — broadcast tells other agents to check the blackboard;
//         ack is the reply confirming the agent has read and responded.
export interface NotiEvent extends FlowEventBase {
  kind: "noti";
  phase: "broadcast" | "ack";
  from: string;
  to: string | string[];
  key?: string;
  message?: string;
}

// Task — input is an incoming user request (Hub only); output is the final result.
export interface TaskEvent extends FlowEventBase {
  kind: "task";
  phase: "input" | "output";
  request?: string;
  result?: unknown;
  scenario?: string;
}

export type FlowEvent =
  | AgentEvent
  | ToolEvent
  | DelegateEvent
  | BlackboardEvent
  | NotiEvent
  | TaskEvent;

export type FlowEventInput =
  | (Omit<AgentEvent, "eventId" | "ts"> & { eventId?: string; ts?: number })
  | (Omit<ToolEvent, "eventId" | "ts"> & { eventId?: string; ts?: number })
  | (Omit<DelegateEvent, "eventId" | "ts"> & { eventId?: string; ts?: number })
  | (Omit<BlackboardEvent, "eventId" | "ts"> & { eventId?: string; ts?: number })
  | (Omit<NotiEvent, "eventId" | "ts"> & { eventId?: string; ts?: number })
  | (Omit<TaskEvent, "eventId" | "ts"> & { eventId?: string; ts?: number });

export interface TaskSummary {
  taskId: string;
  firstTs: number;
  lastTs: number;
  count: number;
  delegates: number;
  blackboard: number;
  tools: number;
  notis: number;
  agents: string[];
  scenario?: string;
}

export interface SpaceSummary {
  space: string;
  agents: number;
  tasks: number;
  lastTs: number;
}

// ---- WebSocket protocol ----
export type ServerMessage =
  | { type: "snapshot"; events: FlowEvent[]; space: string; taskId: string | null }
  | { type: "event"; event: FlowEvent }
  | { type: "tasks"; tasks: TaskSummary[]; total: number }
  | { type: "spaces"; spaces: SpaceSummary[] }
  | { type: "stats"; connected: number; rate: number };

export type ClientMessage =
  | { type: "join"; space: string }
  | { type: "subscribeTask"; taskId: string | null }
  | { type: "deleteTask"; taskId: string }
  | { type: "clearSpace" }
  | { type: "deleteSpace"; space: string };

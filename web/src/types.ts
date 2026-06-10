// Mirror of server/src/types.ts — keep in sync manually.

export const BLACKBOARD_ID = "__blackboard__";

export interface FlowEventBase {
  eventId: string;
  ts: number;
  space?: string;
  agentId: string;
  taskId?: string;
  traceId?: string;
  causedBy?: string;
}

export interface AgentEvent extends FlowEventBase {
  kind: "agent";
  phase: "start" | "end";
  role?: string;
  label?: string;
}

export interface ToolEvent extends FlowEventBase {
  kind: "tool";
  tool: string;
  phase: "start" | "end";
  status?: "ok" | "error";
  input?: unknown;
  output?: unknown;
  summary?: string;
}

export interface DelegateEvent extends FlowEventBase {
  kind: "delegate";
  phase: "dispatch" | "return";
  from: string;
  to: string;
  task?: string;
  payload?: unknown;
}

export interface BlackboardEvent extends FlowEventBase {
  kind: "blackboard";
  op: "read" | "write";
  key: string;
  value?: unknown;
}

export interface NotiEvent extends FlowEventBase {
  kind: "noti";
  phase: "broadcast" | "ack";
  from: string;
  to: string | string[];
  key?: string;
  message?: string;
}

export interface TaskEvent extends FlowEventBase {
  kind: "task";
  phase: "input" | "output";
  request?: string;
  result?: unknown;
  scenario?: string;
}

// Message — agent narration for the execution flow chat panel.
export interface MessageEvent extends FlowEventBase {
  kind: "message";
  title: string;
  content: string;
}

export type FlowEvent =
  | AgentEvent
  | ToolEvent
  | DelegateEvent
  | BlackboardEvent
  | NotiEvent
  | TaskEvent
  | MessageEvent;

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

export type ServerMessage =
  | { type: "snapshot"; events: FlowEvent[]; space: string; taskId: string | null }
  | { type: "event"; event: FlowEvent }
  | { type: "tasks"; tasks: TaskSummary[]; total: number }
  | { type: "spaces"; spaces: SpaceSummary[] }
  | { type: "stats"; connected: number; rate: number };

export type ClientControl =
  | { type: "deleteTask"; taskId: string }
  | { type: "clearSpace" }
  | { type: "deleteSpace"; space: string };

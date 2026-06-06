// Mirror of the server's event model (kept in sync manually).
export type EventKind = "message" | "blackboard" | "agent";

/** Reserved node ids for the shared infrastructure (rendered as backbone nodes). */
export const MESSAGE_SERVER_ID = "__message_server__";
export const BLACKBOARD_ID = "__blackboard__";

export interface FlowEventBase {
  eventId: string;
  ts: number;
  deviceId: string;
  teamId: string;
  agentId: string;
  taskId?: string; // the merge key — correlates work across devices
  traceId?: string;
  correlationId?: string;
  causedBy?: string;
  tool?: string;
}

export interface MessageEvent extends FlowEventBase {
  kind: "message";
  op: "send" | "deliver";
  from: string;
  to: string | null;
  msgType?: string;
  body?: unknown;
  size?: number;
}

export interface BlackboardEvent extends FlowEventBase {
  kind: "blackboard";
  op: "write" | "read" | "update" | "delete";
  key: string;
  value?: unknown;
  version?: number;
}

export interface AgentEvent extends FlowEventBase {
  kind: "agent";
  status: "online" | "offline";
  role?: string;
  capabilities?: string[];
}

export type FlowEvent = MessageEvent | BlackboardEvent | AgentEvent;

export interface TaskSummary {
  taskId: string;
  firstTs: number;
  lastTs: number;
  count: number;
  messages: number;
  blackboard: number;
  devices: string[];
  agents: number;
}

export type ServerMessage =
  | { type: "snapshot"; events: FlowEvent[]; taskId: string | null }
  | { type: "event"; event: FlowEvent }
  | { type: "tasks"; tasks: TaskSummary[]; total: number }
  | { type: "stats"; connected: number; rate: number };

// Mirror of the server's event model (kept in sync manually).

/** Reserved node id for the shared blackboard (rendered as a backbone node). */
export const BLACKBOARD_ID = "__blackboard__";

export interface FlowEventBase {
  eventId: string;
  ts: number;
  deviceId: string;
  teamId: string;
  agentId: string;
  space?: string; // workspace (top-level isolation key)
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

/** Tool use — an agent invoking a tool. Drives the "what is this agent doing now"
 *  busy indicator in the topology. "start" marks busy; "end" releases. */
export interface ToolEvent extends FlowEventBase {
  kind: "tool";
  tool: string;
  phase?: "start" | "end";
  status?: "ok" | "error";
  summary?: string;
}

export type FlowEvent = MessageEvent | BlackboardEvent | AgentEvent | ToolEvent;

export interface TaskSummary {
  taskId: string;
  firstTs: number;
  lastTs: number;
  count: number;
  messages: number;
  blackboard: number;
  tools: number;
  devices: string[];
  agents: number;
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

/** client -> server control messages (delete/clear). Mirrors the server's ClientMessage. */
export type ClientControl =
  | { type: "deleteTask"; taskId: string }
  | { type: "clearSpace" }
  | { type: "deleteSpace"; space: string };

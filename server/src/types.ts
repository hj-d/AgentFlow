// Unified flow-event model shared conceptually with the web client.
// Both the message server and the blackboard are normalized into FlowEvent.

export type EventKind = "message" | "blackboard" | "agent";

/** Reserved node ids for the shared infrastructure (rendered as backbone nodes). */
export const MESSAGE_SERVER_ID = "__message_server__";
export const BLACKBOARD_ID = "__blackboard__";

export interface FlowEventBase {
  /** ULID-ish unique id (server-assigned if omitted by producer). */
  eventId: string;
  /** epoch ms, normalized to the collector clock. */
  ts: number;

  // hierarchical coordinates
  deviceId: string;
  teamId: string;
  agentId: string; // the acting agent

  // task — the merge key. Devices that learn a task_id correlate their work under it.
  taskId?: string;

  // causality — lets the UI stitch a single flow together
  traceId?: string; // whole work flow
  correlationId?: string; // request/response pairing
  causedBy?: string; // previous eventId in the chain

  tool?: string; // which tool produced this
}

export interface MessageEvent extends FlowEventBase {
  kind: "message";
  op: "send" | "deliver";
  from: string; // agentId
  to: string | null; // agentId | topic | "broadcast"
  msgType?: string;
  body?: unknown; // actual payload (req: show data being sent)
  size?: number;
}

export interface BlackboardEvent extends FlowEventBase {
  kind: "blackboard";
  op: "write" | "read" | "update" | "delete";
  key: string; // the blackboard id
  value?: unknown;
  version?: number;
}

/** Agent lifecycle/presence — emitted when an agent starts (online) or stops (offline),
 *  so the topology shows the agent immediately, before it sends any traffic. */
export interface AgentEvent extends FlowEventBase {
  kind: "agent";
  status: "online" | "offline";
  role?: string;
  capabilities?: string[];
}

export type FlowEvent = MessageEvent | BlackboardEvent | AgentEvent;

/** What producers may POST — eventId/ts are filled in by the collector if absent. */
export type FlowEventInput =
  | (Omit<MessageEvent, "eventId" | "ts"> & { eventId?: string; ts?: number })
  | (Omit<BlackboardEvent, "eventId" | "ts"> & { eventId?: string; ts?: number })
  | (Omit<AgentEvent, "eventId" | "ts"> & { eventId?: string; ts?: number });

/** Server-side aggregate for one task — cheap to send regardless of event volume. */
export interface TaskSummary {
  taskId: string;
  firstTs: number;
  lastTs: number;
  count: number; // total events
  messages: number;
  blackboard: number;
  devices: string[];
  agents: number; // distinct agents involved
}

// ---- WebSocket protocol ----
// server -> client
export type ServerMessage =
  | { type: "snapshot"; events: FlowEvent[]; taskId: string | null } // scoped re-sync (presence + focused task)
  | { type: "event"; event: FlowEvent }
  | { type: "tasks"; tasks: TaskSummary[]; total: number } // periodic task list (the scalable default view)
  | { type: "stats"; connected: number; rate: number };

// client -> server
export type ClientMessage = { type: "subscribeTask"; taskId: string | null };

/**
 * AgentFlow client SDK (drop-in, dependency-free).
 *
 * Add emit calls at your message-server relay point and at blackboard read/write.
 * Events are batched and sent fire-and-forget — a collector outage never throws
 * into your agent logic.
 *
 *   const af = new AgentFlowClient({ url: "http://collector:3001/ingest",
 *                                    deviceId: "edge-1" });
 *   af.message({ teamId, agentId: from, from, to, msgType, traceId, body });
 *   af.blackboardWrite({ teamId, agentId, key, value, traceId });
 *   af.blackboardRead({ teamId, agentId, key, traceId });
 *   await af.close(); // flush + stop on shutdown
 */

export type EventKind = "message" | "blackboard" | "agent";

export interface MessageEventInput {
  kind: "message";
  deviceId: string;
  teamId: string;
  agentId: string;
  from: string;
  to: string | null;
  op?: "send" | "deliver";
  msgType?: string;
  body?: unknown;
  size?: number;
  tool?: string;
  space?: string;
  taskId?: string;
  traceId?: string;
  correlationId?: string;
  causedBy?: string;
  ts?: number;
  eventId?: string;
}

export interface BlackboardEventInput {
  kind: "blackboard";
  deviceId: string;
  teamId: string;
  agentId: string;
  op: "write" | "read" | "update" | "delete";
  key: string;
  value?: unknown;
  version?: number;
  tool?: string;
  space?: string;
  taskId?: string;
  traceId?: string;
  correlationId?: string;
  causedBy?: string;
  ts?: number;
  eventId?: string;
}

export interface AgentEventInput {
  kind: "agent";
  deviceId: string;
  teamId: string;
  agentId: string;
  status: "online" | "offline";
  role?: string;
  capabilities?: string[];
  tool?: string;
  space?: string;
  traceId?: string;
  ts?: number;
  eventId?: string;
}

export type FlowEventInput = MessageEventInput | BlackboardEventInput | AgentEventInput;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<unknown>;

export interface AgentFlowOptions {
  /** Collector ingest endpoint, e.g. http://collector:3001/ingest */
  url: string;
  /** Workspace (top-level isolation key) applied to every event. Default "default". */
  space?: string;
  /** Default deviceId applied to every event (overridable per call). */
  deviceId?: string;
  /** Default teamId applied to every event (overridable per call). */
  teamId?: string;
  /** Flush when this many events are queued. Default 20. */
  batchSize?: number;
  /** Auto-flush interval in ms. 0 disables the timer (manual flush only). Default 250. */
  flushIntervalMs?: number;
  /** Drop oldest when the queue exceeds this (collector down). Default 5000. */
  maxQueue?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Called on send failure (default: swallow). */
  onError?: (err: unknown) => void;
}

export class AgentFlowClient {
  private queue: FlowEventInput[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<Omit<AgentFlowOptions, "deviceId" | "teamId" | "onError" | "space">> &
    Pick<AgentFlowOptions, "deviceId" | "teamId" | "onError" | "space">;

  constructor(options: AgentFlowOptions) {
    this.opts = {
      url: options.url,
      space: options.space,
      deviceId: options.deviceId,
      teamId: options.teamId,
      batchSize: options.batchSize ?? 20,
      flushIntervalMs: options.flushIntervalMs ?? 250,
      maxQueue: options.maxQueue ?? 5000,
      fetchImpl: options.fetchImpl ?? ((globalThis as any).fetch as FetchLike),
      onError: options.onError,
    };
    if (this.opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Low-level: enqueue any event. Never throws. */
  emit(event: FlowEventInput): void {
    const e = {
      ...event,
      space: event.space ?? this.opts.space,
      deviceId: event.deviceId ?? this.opts.deviceId,
      teamId: event.teamId ?? this.opts.teamId,
    } as FlowEventInput;
    this.queue.push(e);
    if (this.queue.length > this.opts.maxQueue) {
      this.queue.splice(0, this.queue.length - this.opts.maxQueue);
    }
    if (this.queue.length >= this.opts.batchSize) void this.flush();
  }

  /** Announce an agent has started — call once on agent startup so it shows up immediately. */
  online(
    e: Omit<AgentEventInput, "kind" | "status" | "deviceId" | "teamId"> & { deviceId?: string; teamId?: string }
  ): void {
    this.emit({ kind: "agent", status: "online", ...e } as AgentEventInput);
  }

  /** Announce an agent has stopped. */
  offline(
    e: Omit<AgentEventInput, "kind" | "status" | "deviceId" | "teamId"> & { deviceId?: string; teamId?: string }
  ): void {
    this.emit({ kind: "agent", status: "offline", ...e } as AgentEventInput);
  }

  message(e: Omit<MessageEventInput, "kind" | "deviceId" | "teamId"> & { deviceId?: string; teamId?: string }): void {
    this.emit({ kind: "message", op: e.op ?? "send", ...e } as MessageEventInput);
  }

  blackboardWrite(
    e: Omit<BlackboardEventInput, "kind" | "op" | "deviceId" | "teamId"> & { deviceId?: string; teamId?: string }
  ): void {
    this.emit({ kind: "blackboard", op: "write", ...e } as BlackboardEventInput);
  }

  blackboardRead(
    e: Omit<BlackboardEventInput, "kind" | "op" | "value" | "deviceId" | "teamId"> & {
      deviceId?: string;
      teamId?: string;
    }
  ): void {
    this.emit({ kind: "blackboard", op: "read", ...e } as BlackboardEventInput);
  }

  /** Send everything queued now. Resolves even on failure (re-queues batch). */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      await this.opts.fetchImpl(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      // re-queue (bounded) so a transient outage doesn't lose recent events
      this.queue = batch.concat(this.queue).slice(-this.opts.maxQueue);
      this.opts.onError?.(err);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Flush and stop the timer. Call on shutdown. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

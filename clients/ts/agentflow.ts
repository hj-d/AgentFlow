/**
 * AgentFlow SDK — TypeScript/Node (drop-in, zero dependencies).
 *
 * 7 event kinds: agent · tool · delegate · blackboard · noti · task · message
 * Events are batched and sent fire-and-forget; a collector outage never
 * throws into your agent logic.
 *
 *   const af = new AgentFlowClient({ url: "http://collector:3001/ingest", agentId: "hub" });
 *
 *   af.agentStart({ role: "orchestrator", label: "HomeHub" });
 *   af.dispatch({ from: "hub", to: "pc", task: "영상 편집해줘", taskId: "t-1" });
 *   af.toolStart({ tool: "edit_video", taskId: "t-1" });
 *   af.bbWrite({ key: "video_result", value: { file: "out.mp4" }, taskId: "t-1" });
 *   af.broadcast({ from: "hub", to: ["pc","tv"], key: "task_req", taskId: "t-1" });
 *   af.taskInput({ request: "영상 만들어줘", taskId: "t-1" });
 *
 *   await af.close(); // flush + stop on shutdown
 */

// ---- event input types ----

export interface EventBase {
  agentId?: string;
  space?: string;
  taskId?: string;
  traceId?: string;
  causedBy?: string;
  ts?: number;
  eventId?: string;
}

export interface AgentEventInput extends EventBase {
  kind: "agent";
  phase: "start" | "end";
  role?: string;
  label?: string;
}

export interface ToolEventInput extends EventBase {
  kind: "tool";
  tool: string;
  phase: "start" | "end";
  status?: "ok" | "error";
  input?: unknown;
  output?: unknown;
  summary?: string;
}

export interface DelegateEventInput extends EventBase {
  kind: "delegate";
  phase: "dispatch" | "return";
  from: string;
  to: string;
  task?: string;
  payload?: unknown;
}

export interface BlackboardEventInput extends EventBase {
  kind: "blackboard";
  op: "read" | "write";
  key: string;
  value?: unknown;
}

export interface NotiEventInput extends EventBase {
  kind: "noti";
  phase: "broadcast" | "ack";
  from: string;
  to: string | string[];
  key?: string;
  message?: string;
}

export interface TaskEventInput extends EventBase {
  kind: "task";
  phase: "input" | "output";
  request?: string;
  result?: unknown;
  scenario?: string;
}

export interface MessageEventInput extends EventBase {
  kind: "message";
  title: string;
  content: string;
}

export type FlowEventInput =
  | AgentEventInput
  | ToolEventInput
  | DelegateEventInput
  | BlackboardEventInput
  | NotiEventInput
  | TaskEventInput
  | MessageEventInput;

// ---- client options ----

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

export interface AgentFlowOptions {
  /** Collector ingest endpoint, e.g. http://collector:3001/ingest */
  url: string;
  /** Workspace (top-level isolation key). Default "default". */
  space?: string;
  /** Default agentId applied to every event (overridable per call). */
  agentId?: string;
  /** Flush when this many events are queued. Default 20. */
  batchSize?: number;
  /** Auto-flush interval in ms. 0 disables the timer. Default 250. */
  flushIntervalMs?: number;
  /** Drop oldest when queue exceeds this. Default 5000. */
  maxQueue?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Called on send failure (default: swallow). */
  onError?: (err: unknown) => void;
}

// ---- client ----

export class AgentFlowClient {
  private queue: FlowEventInput[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<Omit<AgentFlowOptions, "agentId" | "space" | "onError">> &
    Pick<AgentFlowOptions, "agentId" | "space" | "onError">;

  constructor(options: AgentFlowOptions) {
    this.opts = {
      url: options.url,
      space: options.space,
      agentId: options.agentId,
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
      agentId: event.agentId ?? this.opts.agentId,
      space: event.space ?? this.opts.space,
    } as FlowEventInput;
    this.queue.push(e);
    if (this.queue.length > this.opts.maxQueue) this.queue.splice(0, this.queue.length - this.opts.maxQueue);
    if (this.queue.length >= this.opts.batchSize) void this.flush();
  }

  // ---- Agent ----

  /** Agent comes online — call once at startup so it appears in the topology immediately. */
  agentStart(e: Omit<AgentEventInput, "kind" | "phase"> & { agentId?: string } = {}): void {
    this.emit({ kind: "agent", phase: "start", ...e });
  }

  /** Agent goes offline. */
  agentEnd(e: Omit<AgentEventInput, "kind" | "phase"> & { agentId?: string } = {}): void {
    this.emit({ kind: "agent", phase: "end", ...e });
  }

  // ---- Tool ----

  /** Mark the agent as busy with a tool. */
  toolStart(e: Omit<ToolEventInput, "kind" | "phase">): void {
    this.emit({ kind: "tool", phase: "start", ...e });
  }

  /** Release the busy state and record the result. */
  toolEnd(e: Omit<ToolEventInput, "kind" | "phase">): void {
    this.emit({ kind: "tool", phase: "end", ...e });
  }

  // ---- Delegate ----

  /** Dispatch work to another agent. */
  dispatch(e: Omit<DelegateEventInput, "kind" | "phase">): void {
    this.emit({ kind: "delegate", phase: "dispatch", ...e });
  }

  /** Return results to the delegating agent. */
  return(e: Omit<DelegateEventInput, "kind" | "phase">): void {
    this.emit({ kind: "delegate", phase: "return", ...e });
  }

  // ---- Blackboard ----

  /** Write a value to the shared blackboard. */
  bbWrite(e: Omit<BlackboardEventInput, "kind" | "op">): void {
    this.emit({ kind: "blackboard", op: "write", ...e });
  }

  /** Read a value from the shared blackboard. */
  bbRead(e: Omit<BlackboardEventInput, "kind" | "op" | "value">): void {
    this.emit({ kind: "blackboard", op: "read", ...e });
  }

  // ---- Noti ----

  /** Broadcast to agents: "check the blackboard at `key`". */
  broadcast(e: Omit<NotiEventInput, "kind" | "phase">): void {
    this.emit({ kind: "noti", phase: "broadcast", ...e });
  }

  /** Acknowledge a broadcast: "I've read and responded to `key`". */
  ack(e: Omit<NotiEventInput, "kind" | "phase">): void {
    this.emit({ kind: "noti", phase: "ack", ...e });
  }

  // ---- Task (Hub only) ----

  /** Hub receives a task from the user. */
  taskInput(e: Omit<TaskEventInput, "kind" | "phase">): void {
    this.emit({ kind: "task", phase: "input", ...e });
  }

  /** Hub returns the final result to the user. */
  taskOutput(e: Omit<TaskEventInput, "kind" | "phase">): void {
    this.emit({ kind: "task", phase: "output", ...e });
  }

  // ---- Message (agent internal log / status) ----

  /** Agent narrates what it's doing — shown in the Agent 대화 panel. */
  message(e: Omit<MessageEventInput, "kind">): void {
    this.emit({ kind: "message", ...e });
  }

  // ---- flush / close ----

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
      this.queue = batch.concat(this.queue).slice(-this.opts.maxQueue);
      this.opts.onError?.(err);
    }
  }

  get pending(): number { return this.queue.length; }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

import type { WebSocket } from "ws";
import type { FlowEvent, ServerMessage, ClientMessage, TaskSummary } from "./types.js";
import { RingBuffer } from "./ringBuffer.js";

interface Subscription {
  taskId: string | null; // focused task; null = no task detail (presence + summaries only)
}

interface TaskAgg {
  taskId: string;
  firstTs: number;
  lastTs: number;
  count: number;
  messages: number;
  blackboard: number;
  devices: Set<string>;
  agents: Set<string>;
}

const MAX_TASKS_SENT = 100; // cap the task list pushed to clients (most-recent first)

/**
 * Scales by sending each client only what it is viewing:
 *  - ALWAYS: agent presence events + periodic task summaries (cheap, bounded).
 *  - ON DEMAND: the events of the one task a client has focused.
 * The full event firehose is never broadcast to every client.
 */
export class Hub {
  private clients = new Map<WebSocket, Subscription>();
  private buffer: RingBuffer<FlowEvent>; // recent events, for scoped snapshots
  private presence = new Map<string, FlowEvent>(); // latest agent event per agent id
  private tasks = new Map<string, TaskAgg>();
  private windowCount = 0;
  private statsTimer: ReturnType<typeof setInterval>;
  private tasksTimer: ReturnType<typeof setInterval>;

  constructor(snapshotSize: number) {
    this.buffer = new RingBuffer<FlowEvent>(snapshotSize);
    this.statsTimer = setInterval(() => {
      const rate = this.windowCount;
      this.windowCount = 0;
      this.broadcastAll({ type: "stats", connected: this.clients.size, rate });
    }, 1000);
    this.statsTimer.unref?.();
    // task summaries on a fixed cadence — decouples client load from event rate
    this.tasksTimer = setInterval(() => this.broadcastTasks(), 700);
    this.tasksTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.statsTimer);
    clearInterval(this.tasksTimer);
  }

  addClient(ws: WebSocket): void {
    const sub: Subscription = { taskId: null };
    this.clients.set(ws, sub);
    this.sendSnapshot(ws, sub);
    this.send(ws, this.tasksMessage());

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "subscribeTask") {
        sub.taskId = msg.taskId;
        this.sendSnapshot(ws, sub); // re-sync to the new scope
      }
    });
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  ingest(event: FlowEvent): void {
    this.buffer.push(event);
    this.windowCount++;
    if (event.kind === "agent") {
      this.presence.set(`${event.deviceId}/${event.teamId}/${event.agentId}`, event);
    }
    if (event.taskId) this.updateTask(event);

    // deliver only to clients whose subscription matches
    const data = JSON.stringify({ type: "event", event } satisfies ServerMessage);
    for (const [ws, sub] of this.clients) {
      if (this.matches(sub, event) && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  /** An event reaches a client if it's presence (always) or belongs to its focused task. */
  private matches(sub: Subscription, e: FlowEvent): boolean {
    if (e.kind === "agent") return true;
    return sub.taskId != null && e.taskId === sub.taskId;
  }

  private updateTask(e: FlowEvent): void {
    const id = e.taskId!;
    let t = this.tasks.get(id);
    if (!t) {
      t = { taskId: id, firstTs: e.ts, lastTs: e.ts, count: 0, messages: 0, blackboard: 0, devices: new Set(), agents: new Set() };
      this.tasks.set(id, t);
    }
    t.lastTs = e.ts;
    t.count++;
    if (e.kind === "message") t.messages++;
    else if (e.kind === "blackboard") t.blackboard++;
    t.devices.add(e.deviceId);
    t.agents.add(`${e.deviceId}/${e.teamId}/${e.agentId}`);
  }

  private summaries(): TaskSummary[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, MAX_TASKS_SENT)
      .map((t) => ({
        taskId: t.taskId,
        firstTs: t.firstTs,
        lastTs: t.lastTs,
        count: t.count,
        messages: t.messages,
        blackboard: t.blackboard,
        devices: [...t.devices],
        agents: t.agents.size,
      }));
  }

  private tasksMessage(): ServerMessage {
    return { type: "tasks", tasks: this.summaries(), total: this.tasks.size };
  }

  private broadcastTasks(): void {
    if (this.tasks.size === 0) return;
    this.broadcastAll(this.tasksMessage());
  }

  /** Scoped re-sync: all presence + (if focused) that task's recent events. */
  private sendSnapshot(ws: WebSocket, sub: Subscription): void {
    const events: FlowEvent[] = [...this.presence.values()];
    if (sub.taskId != null) {
      for (const e of this.buffer.snapshot()) if (e.taskId === sub.taskId) events.push(e);
    }
    events.sort((a, b) => a.ts - b.ts);
    this.send(ws, { type: "snapshot", events, taskId: sub.taskId });
  }

  private broadcastAll(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  get clientCount(): number {
    return this.clients.size;
  }
  get taskCount(): number {
    return this.tasks.size;
  }
}

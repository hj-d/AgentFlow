import type { WebSocket } from "ws";
import type { FlowEvent, ServerMessage, ClientMessage, TaskSummary, SpaceSummary } from "./types.js";
import { DEFAULT_SPACE } from "./types.js";
import { RingBuffer } from "./ringBuffer.js";

interface Subscription {
  space: string;
  taskId: string | null;
}

interface TaskAgg {
  taskId: string;
  firstTs: number;
  lastTs: number;
  count: number;
  delegates: number;
  blackboard: number;
  tools: number;
  notis: number;
  agents: Set<string>;
  scenario?: string;
}

interface SpaceState {
  buffer: RingBuffer<FlowEvent>;
  presence: Map<string, FlowEvent>; // latest agent event per agentId
  tasks: Map<string, TaskAgg>;
  lastTs: number;
}

const MAX_TASKS_SENT = 100;

export class Hub {
  private clients = new Map<WebSocket, Subscription>();
  private spaces = new Map<string, SpaceState>();
  private windowCount = 0;
  private statsTimer: ReturnType<typeof setInterval>;
  private tasksTimer: ReturnType<typeof setInterval>;
  private spacesTimer: ReturnType<typeof setInterval>;

  constructor(private readonly snapshotSize: number) {
    this.statsTimer = setInterval(() => {
      const rate = this.windowCount;
      this.windowCount = 0;
      this.broadcastAll({ type: "stats", connected: this.clients.size, rate });
    }, 1000);
    this.statsTimer.unref?.();
    this.tasksTimer = setInterval(() => this.broadcastTasks(), 700);
    this.tasksTimer.unref?.();
    this.spacesTimer = setInterval(() => this.broadcastSpaces(), 1500);
    this.spacesTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.statsTimer);
    clearInterval(this.tasksTimer);
    clearInterval(this.spacesTimer);
  }

  private space(name: string): SpaceState {
    let s = this.spaces.get(name);
    if (!s) {
      s = { buffer: new RingBuffer<FlowEvent>(this.snapshotSize), presence: new Map(), tasks: new Map(), lastTs: 0 };
      this.spaces.set(name, s);
    }
    return s;
  }

  addClient(ws: WebSocket): void {
    const sub: Subscription = { space: DEFAULT_SPACE, taskId: null };
    this.clients.set(ws, sub);
    this.sendSnapshot(ws, sub);
    this.send(ws, this.tasksMessage(sub.space));
    this.send(ws, this.spacesMessage());

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "join") {
        sub.space = msg.space || DEFAULT_SPACE;
        sub.taskId = null;
        this.sendSnapshot(ws, sub);
        this.send(ws, this.tasksMessage(sub.space));
      } else if (msg.type === "subscribeTask") {
        sub.taskId = msg.taskId;
        this.sendSnapshot(ws, sub);
      } else if (msg.type === "deleteTask") {
        this.deleteTask(sub.space, msg.taskId);
      } else if (msg.type === "clearSpace") {
        this.clearSpace(sub.space);
      } else if (msg.type === "deleteSpace") {
        this.deleteSpace(msg.space || sub.space);
      }
    });
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  ingest(event: FlowEvent): void {
    const spaceName = event.space ?? DEFAULT_SPACE;
    const st = this.space(spaceName);
    st.buffer.push(event);
    st.lastTs = event.ts;
    this.windowCount++;

    if (event.kind === "agent") {
      st.presence.set(event.agentId, event);
    }
    if (event.taskId) this.updateTask(st, event);

    const data = JSON.stringify({ type: "event", event } satisfies ServerMessage);
    for (const [ws, sub] of this.clients) {
      if (sub.space === spaceName && this.matches(sub, event) && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  private matches(sub: Subscription, e: FlowEvent): boolean {
    if (e.kind === "agent") return true;
    return sub.taskId != null && e.taskId === sub.taskId;
  }

  private updateTask(st: SpaceState, e: FlowEvent): void {
    const id = e.taskId!;
    let t = st.tasks.get(id);
    if (!t) {
      t = { taskId: id, firstTs: e.ts, lastTs: e.ts, count: 0, delegates: 0, blackboard: 0, tools: 0, notis: 0, agents: new Set() };
      st.tasks.set(id, t);
    }
    t.lastTs = e.ts;
    t.count++;
    if (e.kind === "delegate") t.delegates++;
    else if (e.kind === "blackboard") t.blackboard++;
    else if (e.kind === "tool") t.tools++;
    else if (e.kind === "noti") t.notis++;
    else if (e.kind === "task" && e.scenario) t.scenario = e.scenario;
    t.agents.add(e.agentId);
  }

  deleteTask(spaceName: string, taskId: string): void {
    const st = this.spaces.get(spaceName);
    if (!st || !st.tasks.delete(taskId)) return;
    st.buffer.removeWhere((e) => e.taskId === taskId);
    for (const [ws, sub] of this.clients) {
      if (sub.space === spaceName && sub.taskId === taskId) {
        sub.taskId = null;
        this.sendSnapshot(ws, sub);
      }
    }
    this.pushTasks(spaceName);
  }

  clearSpace(spaceName: string): void {
    const st = this.spaces.get(spaceName);
    if (!st) return;
    st.tasks.clear();
    st.buffer.clear();
    for (const [ws, sub] of this.clients) {
      if (sub.space === spaceName) {
        sub.taskId = null;
        this.sendSnapshot(ws, sub);
      }
    }
    this.pushTasks(spaceName);
  }

  deleteSpace(spaceName: string): void {
    if (!this.spaces.delete(spaceName)) return;
    for (const [ws, sub] of this.clients) {
      if (sub.space === spaceName && ws.readyState === ws.OPEN) {
        sub.taskId = null;
        this.send(ws, { type: "snapshot", events: [], space: spaceName, taskId: null });
        this.send(ws, this.tasksMessage(spaceName));
      }
    }
    this.broadcastAll(this.spacesMessage());
  }

  private pushTasks(spaceName: string): void {
    const data = JSON.stringify(this.tasksMessage(spaceName));
    for (const [ws, sub] of this.clients) {
      if (sub.space === spaceName && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  private tasksMessage(spaceName: string): ServerMessage {
    const st = this.spaces.get(spaceName);
    const all = st ? [...st.tasks.values()] : [];
    const tasks: TaskSummary[] = all
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, MAX_TASKS_SENT)
      .map((t) => ({
        taskId: t.taskId,
        firstTs: t.firstTs,
        lastTs: t.lastTs,
        count: t.count,
        delegates: t.delegates,
        blackboard: t.blackboard,
        tools: t.tools,
        notis: t.notis,
        agents: [...t.agents],
        scenario: t.scenario,
      }));
    return { type: "tasks", tasks, total: all.length };
  }

  private spacesMessage(): ServerMessage {
    const spaces: SpaceSummary[] = [...this.spaces.entries()]
      .map(([space, st]) => ({ space, agents: st.presence.size, tasks: st.tasks.size, lastTs: st.lastTs }))
      .sort((a, b) => b.lastTs - a.lastTs);
    return { type: "spaces", spaces };
  }

  private broadcastTasks(): void {
    const cache = new Map<string, string>();
    for (const [ws, sub] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      let data = cache.get(sub.space);
      if (!data) { data = JSON.stringify(this.tasksMessage(sub.space)); cache.set(sub.space, data); }
      ws.send(data);
    }
  }

  private broadcastSpaces(): void {
    if (this.spaces.size === 0) return;
    this.broadcastAll(this.spacesMessage());
  }

  private sendSnapshot(ws: WebSocket, sub: Subscription): void {
    const st = this.spaces.get(sub.space);
    const events: FlowEvent[] = st ? [...st.presence.values()] : [];
    if (st && sub.taskId != null) {
      for (const e of st.buffer.snapshot()) if (e.taskId === sub.taskId) events.push(e);
    }
    events.sort((a, b) => a.ts - b.ts);
    this.send(ws, { type: "snapshot", events, space: sub.space, taskId: sub.taskId });
  }

  private broadcastAll(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  get clientCount(): number { return this.clients.size; }
  get spaceCount(): number { return this.spaces.size; }
  taskCount(space = DEFAULT_SPACE): number { return this.spaces.get(space)?.tasks.size ?? 0; }
}

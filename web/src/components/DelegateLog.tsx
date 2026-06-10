import { useMemo } from "react";
import { useStore } from "../store";
import type { FlowEvent } from "../types";

// Agent color palette — hub is always "right", others cycle through palette
const AGENT_META: Record<string, { icon: string; name: string; cls: string }> = {
  hub: { icon: "📡", name: "HomeHub", cls: "hub" },
  pc:  { icon: "🖥️",  name: "PC Agent", cls: "pc"  },
  tv:  { icon: "📺", name: "TV Agent", cls: "tv"  },
};

// Fallback for unknown agents
function agentMeta(id: string) {
  return AGENT_META[id] ?? { icon: "🤖", name: id, cls: "unknown-agent" };
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatResultSummary(result: unknown): React.ReactNode {
  if (result == null) return "완료";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const r = result as Record<string, unknown>;

  const msg = typeof r.message === "string" ? r.message : null;
  const meta: string[] = [];
  if (r.video || r.file) meta.push(`🎬 ${r.video ?? r.file}`);
  if (r.duration) meta.push(`⏱ ${r.duration}`);
  if (r.status && r.status !== msg) meta.push(String(r.status));

  if (msg) {
    return meta.length > 0 ? (
      <>
        <div className="task-result-main">{msg}</div>
        <div className="task-result-meta">{meta.join("  ·  ")}</div>
      </>
    ) : msg;
  }

  const pairs = Object.entries(r)
    .filter(([, v]) => v != null && typeof v !== "object")
    .map(([k, v]) => {
      if (k === "video" || k === "file") return `🎬 ${v}`;
      if (k === "duration") return `⏱ ${v}`;
      return `${k}: ${v}`;
    });
  return pairs.length > 0 ? pairs.join("  ·  ") : JSON.stringify(r).slice(0, 100);
}

// ---- Determine which events to show as chat ----
type ChatItem =
  | { type: "task-in";  ev: Extract<FlowEvent, { kind: "task" }> }
  | { type: "task-out"; ev: Extract<FlowEvent, { kind: "task" }> }
  | { type: "msg";      ev: Extract<FlowEvent, { kind: "message" }> };

function buildChat(events: FlowEvent[], taskId: string | undefined): ChatItem[] {
  const chron = [...events].reverse(); // events are newest-first, reverse for chron
  return chron
    .filter((e) => {
      if (taskId && e.taskId && e.taskId !== taskId) return false;
      return e.kind === "task" || e.kind === "message";
    })
    .map((e): ChatItem | null => {
      if (e.kind === "task") {
        const t = e as Extract<FlowEvent, { kind: "task" }>;
        return { type: t.phase === "input" ? "task-in" : "task-out", ev: t };
      }
      if (e.kind === "message") {
        return { type: "msg", ev: e as Extract<FlowEvent, { kind: "message" }> };
      }
      return null;
    })
    .filter((x): x is ChatItem => x !== null);
}

// ---- Task system message ----
function TaskBubble({ item }: { item: ChatItem & { type: "task-in" | "task-out" } }) {
  const e = item.ev;
  const isIn = item.type === "task-in";
  const scenLabel = e.scenario === "scenario-1" ? "S1" : e.scenario === "scenario-2" ? "S2" : e.scenario;
  return (
    <div className={`chat-system ${isIn ? "task-in" : "task-out"}`}>
      <div className="chat-sys-head">
        <span className="chat-sys-label">{isIn ? "🎯 Task Input" : "✅ Task Output"}</span>
        {scenLabel && <span className="chat-scenario-badge">{scenLabel}</span>}
        <span className="chat-ts">{fmtTime(e.ts)}</span>
      </div>
      <div className="chat-sys-text">
        {isIn ? e.request : formatResultSummary(e.result)}
      </div>
    </div>
  );
}

// ---- Agent message chat bubble ----
function MsgBubble({ item }: { item: ChatItem & { type: "msg" } }) {
  const e = item.ev;
  const isHub = e.agentId === "hub";
  const meta = agentMeta(e.agentId);

  return (
    <div className={`chat-msg-row ${isHub ? "hub-side" : "other-side"}`}>
      {!isHub && (
        <div className="chat-avatar other">
          <span>{meta.icon}</span>
        </div>
      )}
      <div className={`chat-bubble-wrap ${isHub ? "hub" : "other"}`}>
        <div className={`chat-agent-label ${meta.cls}`}>
          {meta.icon} {meta.name}
        </div>
        <div className={`chat-bubble ${meta.cls}`}>
          <div className="chat-bubble-title">{e.title}</div>
          <div className="chat-bubble-content">{e.content}</div>
        </div>
        <div className="chat-ts">{fmtTime(e.ts)}</div>
      </div>
      {isHub && (
        <div className="chat-avatar hub">
          <span>{meta.icon}</span>
        </div>
      )}
    </div>
  );
}

// ---- Main component (exported as DelegateLog for App.tsx compatibility) ----
export function DelegateLog() {
  const events   = useStore((s) => s.events);
  const taskIO   = useStore((s) => s.taskIO);
  const taskId   = taskIO?.taskId;

  const chatItems = useMemo(() => buildChat(events, taskId), [events, taskId]);

  if (chatItems.length === 0) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon">💬</div>
        <div>대화 대기 중…</div>
        <div className="chat-empty-sub">시뮬레이터가 실행되면 Hub와 Agent의 대화가 여기에 표시됩니다</div>
      </div>
    );
  }

  return (
    <div className="chat-flow">
      {chatItems.map((item, idx) => {
        if (item.type === "task-in" || item.type === "task-out") {
          return <TaskBubble key={item.ev.eventId ?? idx} item={item} />;
        }
        return <MsgBubble key={item.ev.eventId ?? idx} item={item} />;
      })}
    </div>
  );
}

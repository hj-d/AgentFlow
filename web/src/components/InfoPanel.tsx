import { useState } from "react";
import { useStore } from "../store";
import type { FlowEvent } from "../types";

// ---- Helpers ----
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtAge(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

function snip(v: unknown, max = 55): string {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmtResult(result: unknown): string {
  if (!result) return "완료";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const r = result as Record<string, unknown>;
  if (typeof r.message === "string") return r.message;
  const parts: string[] = [];
  if (r.video || r.file) parts.push(`🎬 ${r.video ?? r.file}`);
  if (r.duration) parts.push(`⏱ ${r.duration}`);
  if (r.status) parts.push(String(r.status));
  return parts.join(" · ") || snip(r, 60);
}

// ---- Event description ----
type EvDesc = { direction?: string; text: string; detail?: unknown };

function getEvDesc(e: FlowEvent): EvDesc {
  switch (e.kind) {
    case "task":
      return {
        text: e.phase === "input"
          ? `"${snip(e.request, 55)}"`
          : `완료 · ${fmtResult(e.result)}`,
        detail: e.phase === "output" ? e.result : null,
      };
    case "delegate": {
      const dir = `${e.from} → ${e.to}`;
      return {
        direction: dir,
        text: e.phase === "dispatch"
          ? (e.task ? `"${snip(e.task, 45)}"` : "작업 위임")
          : "결과 반환",
        detail: e.payload,
      };
    }
    case "tool":
      return {
        direction: e.agentId,
        text: e.phase === "start"
          ? `${e.tool} 시작`
          : `${e.tool} ${e.status === "error" ? "실패" : "완료"}${e.output ? " · " + snip(e.output, 35) : ""}`,
        detail: e.phase === "end" ? { output: e.output, input: e.input } : e.input,
      };
    case "blackboard":
      return {
        direction: e.agentId,
        text: e.op === "write"
          ? `${e.key} = ${snip(e.value, 40)}`
          : `${e.key} 읽기`,
        detail: e.op === "write" ? e.value : null,
      };
    case "noti": {
      const targets = Array.isArray(e.to) ? e.to.join(", ") : String(e.to);
      return {
        direction: `${e.from} → ${targets}`,
        text: e.phase === "broadcast"
          ? `${e.key ? e.key + " " : ""}알림 전송${e.message ? " · \"" + snip(e.message, 30) + "\"" : ""}`
          : `알림 확인`,
        detail: e.message || null,
      };
    }
    case "message":
      return {
        direction: e.agentId,
        text: e.title,
        detail: e.content,
      };
    case "agent":
      return {
        text: `${e.agentId} ${e.phase === "start" ? "온라인" : "오프라인"}`,
      };
    default:
      return { text: snip((e as Record<string, unknown>).kind, 30) };
  }
}

// ---- Badge label per event kind ----
function getBadgeInfo(e: FlowEvent): { label: string; cls: string } {
  switch (e.kind) {
    case "task":      return { label: e.phase === "input" ? "작업 시작" : "작업 완료", cls: "task" };
    case "delegate":  return { label: e.phase === "dispatch" ? "위임" : "위임 반환", cls: "delegate" };
    case "tool":      return {
      label: e.phase === "start" ? "도구 시작" : (e.status === "error" ? "도구 실패" : "도구 완료"),
      cls: e.phase === "end" && e.status === "error" ? "tool-err" : "tool"
    };
    case "blackboard":return { label: e.op === "write" ? "BB 쓰기" : "BB 읽기", cls: e.op === "write" ? "bb-write" : "bb-read" };
    case "noti":      return { label: e.phase === "broadcast" ? "알림" : "알림 확인", cls: "noti" };
    case "message":   return { label: "메시지", cls: "message" };
    case "agent":     return { label: e.phase === "start" ? "온라인" : "오프라인", cls: "agent" };
    default:          return { label: (e as any).kind, cls: "other" };
  }
}

// ---- Single event row ----
function EvRow({ event: e }: { event: FlowEvent }) {
  const [open, setOpen] = useState(false);
  const desc = getEvDesc(e);
  const badge = getBadgeInfo(e);
  const hasDetail = desc.detail != null;

  return (
    <div
      className={`ev-row ${badge.cls}${hasDetail ? " clickable" : ""}${open ? " open" : ""}`}
      onClick={() => hasDetail && setOpen((o) => !o)}
    >
      <div className="ev-row-main">
        <span className="ev-time">{fmtTime(e.ts)}</span>
        <span className={`ev-badge ${badge.cls}`}>{badge.label}</span>
        <div className="ev-body">
          {desc.direction && (
            <span className="ev-direction">{desc.direction}</span>
          )}
          <span className="ev-text">{desc.text}</span>
        </div>
        {hasDetail && (
          <span className="ev-expand-icon">{open ? "▾" : "▸"}</span>
        )}
      </div>
      {open && hasDetail && (
        <pre className="ev-detail">
          {typeof desc.detail === "string"
            ? desc.detail
            : JSON.stringify(desc.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---- Event Timeline tab ----
function EventTimeline() {
  const events = useStore((s) => s.events);
  const selectedTask = useStore((s) => s.selectedTask);

  const filtered = selectedTask
    ? events.filter((e) => !e.taskId || e.taskId === selectedTask)
    : events;

  if (filtered.length === 0) {
    return (
      <div className="ev-empty">
        <div className="ev-empty-icon">📋</div>
        <div>이벤트 없음</div>
        <div className="ev-empty-sub">시뮬레이터가 실행되면 이벤트가 여기에 표시됩니다</div>
      </div>
    );
  }

  return (
    <div className="ev-timeline">
      {filtered.map((e) => (
        <EvRow key={e.eventId} event={e} />
      ))}
    </div>
  );
}

// ---- Tasks Tab ----
function TasksTab() {
  const tasks        = useStore((s) => s.tasks);
  const tasksTotal   = useStore((s) => s.tasksTotal);
  const selectedTask = useStore((s) => s.selectedTask);
  const selectTask   = useStore((s) => s.selectTask);
  const deleteTask   = useStore((s) => s.deleteTask);
  const clearSpace   = useStore((s) => s.clearSpace);
  const replayTask   = useStore((s) => s.replayTask);
  const stopReplay   = useStore((s) => s.stopReplay);
  const isReplaying  = useStore((s) => s.isReplaying);
  const events       = useStore((s) => s.events);

  const list = Object.values(tasks).sort((a, b) => b.lastTs - a.lastTs);

  function isCompleted(taskId: string) {
    return events.some((e) => e.kind === "task" && e.phase === "output" && e.taskId === taskId);
  }

  const SCENARIO_LABELS: Record<string, string> = {
    "scenario-1": "S1",
    "scenario-2": "S2",
  };

  return (
    <>
      <div className="task-list-head">
        <span className="task-list-count">{tasksTotal}개 작업</span>
        <div className="task-list-actions">
          {selectedTask && (
            <button className="btn" onClick={() => selectTask(null)}>전체 보기</button>
          )}
          <button className="btn danger" onClick={() => clearSpace()}>전체 삭제</button>
        </div>
      </div>
      <div className="task-list">
        {list.length === 0 && (
          <div className="task-empty">작업 없음 — 시뮬레이터를 실행하세요</div>
        )}
        {list.map((t) => {
          const completed = isCompleted(t.taskId);
          const isReplayingThis = isReplaying && selectedTask === t.taskId;
          const scenLabel = t.scenario ? (SCENARIO_LABELS[t.scenario] ?? t.scenario) : null;
          return (
            <div
              key={t.taskId}
              className={`task-row${selectedTask === t.taskId ? " sel" : ""}`}
              onClick={() => selectTask(t.taskId)}
            >
              <div className="task-row-top">
                <span className="task-id">{t.taskId}</span>
                {scenLabel && (
                  <span className={`task-scen ${t.scenario}`}>{scenLabel}</span>
                )}
                <span className="task-age">{fmtAge(t.lastTs)}</span>
              </div>
              <div className="task-row-meta">
                <span className="task-stat" title="위임">↔ {t.delegates}</span>
                <span className="task-stat" title="도구">⚙ {t.tools}</span>
                <span className="task-stat" title="알림">📢 {t.notis}</span>
                <div style={{ flex: 1 }} />
                {completed && (
                  isReplayingThis ? (
                    <button
                      className="task-replay-btn active"
                      onClick={(ev) => { ev.stopPropagation(); stopReplay(); }}
                    >⏹ 중지</button>
                  ) : (
                    <button
                      className="task-replay-btn"
                      onClick={(ev) => { ev.stopPropagation(); replayTask(t.taskId); }}
                    >▶ 다시보기</button>
                  )
                )}
                <button
                  className="task-del"
                  onClick={(ev) => { ev.stopPropagation(); deleteTask(t.taskId); }}
                >✕</button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---- InfoPanel ----
export function InfoPanel() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const events = useStore((s) => s.events);
  const selectedTask = useStore((s) => s.selectedTask);
  const taskIO = useStore((s) => s.taskIO);

  const evCount = selectedTask
    ? events.filter((e) => !e.taskId || e.taskId === selectedTask).length
    : events.length;

  const safeTab = (activeTab === "events" || activeTab === "tasks") ? activeTab : "events";

  const scenLabels: Record<string, string> = {
    "scenario-1": "S1: 도구 기반",
    "scenario-2": "S2: 블랙보드+병렬",
  };

  return (
    <>
      {/* Mini task banner */}
      {taskIO && (
        <div className="side-task-banner">
          {taskIO.scenario && (
            <span className={`side-scen-badge ${taskIO.scenario}`}>
              {scenLabels[taskIO.scenario] ?? taskIO.scenario}
            </span>
          )}
          <span className="side-task-text">{taskIO.result != null ? "✅ 완료" : "⏳ 처리 중"}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="side-tabs">
        <button
          className={`side-tab${safeTab === "events" ? " active" : ""}`}
          onClick={() => setActiveTab("events")}
        >
          이벤트 흐름
          {evCount > 0 && <span className="side-tab-count">{evCount}</span>}
        </button>
        <button
          className={`side-tab${safeTab === "tasks" ? " active" : ""}`}
          onClick={() => setActiveTab("tasks")}
        >
          작업 목록
        </button>
      </div>

      <div className="side-content">
        {safeTab === "events" && <EventTimeline />}
        {safeTab === "tasks"  && <TasksTab />}
      </div>
    </>
  );
}

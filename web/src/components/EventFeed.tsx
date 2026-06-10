import { useMemo } from "react";
import { useStore } from "../store";
import type { FlowEvent } from "../types";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function summarize(e: FlowEvent): string {
  switch (e.kind) {
    case "agent":
      return `${e.agentId} ${e.phase === "start" ? "came online" : "went offline"}${e.role ? ` (${e.role})` : ""}`;
    case "tool": {
      const mark = e.phase === "end" ? (e.status === "error" ? " ✗" : " ✓") : " …";
      return `${e.agentId} ⚙ ${e.tool}${mark}`;
    }
    case "delegate":
      return `${e.from} → ${e.to}  [${e.phase}]${e.task ? "  " + e.task.slice(0, 40) : ""}`;
    case "blackboard":
      return `${e.agentId} ${e.op.toUpperCase()} ${e.key}`;
    case "noti": {
      const to = Array.isArray(e.to) ? e.to.join(", ") : e.to;
      return `${e.from} → ${to}  [${e.phase}]${e.key ? "  " + e.key : ""}`;
    }
    case "task":
      return `Task ${e.phase.toUpperCase()}${e.request ? "  " + e.request.slice(0, 40) : ""}${e.scenario ? "  (" + e.scenario + ")" : ""}`;
  }
}

function payload(e: FlowEvent): unknown {
  if (e.kind === "delegate") return e.payload;
  if (e.kind === "blackboard") return e.value;
  if (e.kind === "tool" && e.phase === "end") return e.output;
  if (e.kind === "task") return e.result ?? e.request;
  return undefined;
}

const BADGE_TEXT: Record<FlowEvent["kind"], string> = {
  agent: "AGENT", tool: "TOOL", delegate: "DELG", blackboard: "BB", noti: "NOTI", task: "TASK",
};

export function EventFeed() {
  const events = useStore((s) => s.events);
  const selectedTask = useStore((s) => s.selectedTask);
  const selectTask = useStore((s) => s.selectTask);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (selectedTask && e.kind !== "agent" && e.taskId !== selectedTask) return false;
      return true;
    });
  }, [events, selectedTask]);

  return (
    <div className="event-feed">
      {filtered.length === 0 && (
        <div className="event-feed-empty">
          {selectedTask ? "이 Task의 이벤트 없음" : "이벤트 없음 — task를 선택하거나 시뮬레이터를 실행하세요"}
        </div>
      )}
      {filtered.map((e) => {
        const p = payload(e);
        const pStr = p !== undefined ? (typeof p === "string" ? p : JSON.stringify(p)) : "";
        return (
          <div
            key={e.eventId}
            className="feed-row"
            onClick={() => e.taskId && selectTask(e.taskId)}
            title={e.taskId ? `task: ${e.taskId}` : ""}
          >
            <span className="feed-time">{fmtTime(e.ts)}</span>
            <span className={`badge ${e.kind}`}>{BADGE_TEXT[e.kind]}</span>
            <span className="feed-summary">{summarize(e)}</span>
            {pStr && <span className="feed-payload">{pStr.slice(0, 60)}</span>}
          </div>
        );
      })}
    </div>
  );
}

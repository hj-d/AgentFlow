import { useMemo, useState } from "react";
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
    case "message":
      return `[${e.agentId}] ${e.title}: ${e.content.slice(0, 50)}`;
  }
}

function eventDetail(e: FlowEvent): Record<string, unknown> {
  const base: Record<string, unknown> = { kind: e.kind, agentId: e.agentId, ts: e.ts };
  if (e.taskId) base.taskId = e.taskId;
  switch (e.kind) {
    case "agent":      return { ...base, phase: e.phase, role: e.role, label: e.label };
    case "tool":       return e.phase === "end"
      ? { ...base, tool: e.tool, phase: e.phase, status: e.status, output: e.output }
      : { ...base, tool: e.tool, phase: e.phase, input: e.input };
    case "delegate":   return e.phase === "dispatch"
      ? { ...base, phase: e.phase, from: e.from, to: e.to, task: e.task }
      : { ...base, phase: e.phase, from: e.from, to: e.to, payload: e.payload };
    case "blackboard": return e.op === "write"
      ? { ...base, op: e.op, key: e.key, value: e.value }
      : { ...base, op: e.op, key: e.key };
    case "noti":       return { ...base, phase: e.phase, from: e.from, to: e.to, key: e.key, message: e.message };
    case "task":       return e.phase === "input"
      ? { ...base, phase: e.phase, request: e.request, scenario: e.scenario }
      : { ...base, phase: e.phase, result: e.result };
    case "message":    return { ...base, title: e.title, content: e.content };
  }
}

const BADGE_TEXT: Record<FlowEvent["kind"], string> = {
  agent: "AGENT", tool: "TOOL", delegate: "DELG", blackboard: "BB", noti: "NOTI", task: "TASK", message: "MSG",
};

export function EventFeed() {
  const events = useStore((s) => s.events);
  const selectedTask = useStore((s) => s.selectedTask);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
          {selectedTask ? "이 Task의 이벤트 없음" : "이벤트 없음 — 시뮬레이터를 실행하세요"}
        </div>
      )}
      {filtered.map((e) => {
        const isExpanded = expandedId === e.eventId;
        return (
          <div
            key={e.eventId}
            className={`feed-row${isExpanded ? " expanded" : ""}`}
            onClick={() => setExpandedId(isExpanded ? null : e.eventId)}
            title="클릭하면 상세 보기"
          >
            <span className="feed-time">{fmtTime(e.ts)}</span>
            <span className={`badge ${e.kind}`}>{BADGE_TEXT[e.kind]}</span>
            <span className="feed-summary">{summarize(e)}</span>
            {isExpanded && (
              <pre className="feed-row-detail">{JSON.stringify(eventDetail(e), null, 2)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

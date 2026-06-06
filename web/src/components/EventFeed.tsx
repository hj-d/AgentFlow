import { useMemo } from "react";
import { useStore } from "../store";
import type { FlowEvent } from "../types";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function short(id: string): string {
  const parts = id.split("/");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : id;
}

function summarize(e: FlowEvent): string {
  if (e.kind === "message") {
    return `${short(e.from)} → ${e.to ? short(e.to) : "?"}  [${e.msgType ?? "msg"}]`;
  }
  if (e.kind === "blackboard") {
    return `${e.op.toUpperCase()} ${e.key}`;
  }
  return `${e.status.toUpperCase()} ${e.agentId}${e.role ? " (" + e.role + ")" : ""}`;
}

const BADGE: Record<FlowEvent["kind"], string> = { message: "MSG", blackboard: "BB", agent: "AGT" };

export function EventFeed() {
  const events = useStore((s) => s.events);
  const filters = useStore((s) => s.filters);
  const selectedTask = useStore((s) => s.selectedTask);
  const selectTask = useStore((s) => s.selectTask);

  const filtered = useMemo(() => {
    const text = filters.text.toLowerCase();
    return events.filter((e) => {
      // Show ONLY the focused task's own actions. The store also holds global
      // agent-presence events (needed to render the topology roster); those carry
      // no taskId and would otherwise clutter this feed with unrelated online/offline noise.
      if (selectedTask && e.taskId !== selectedTask) return false;
      if (filters.kind !== "all" && e.kind !== filters.kind) return false;
      if (filters.device && e.deviceId !== filters.device) return false;
      if (filters.team && e.teamId !== filters.team) return false;
      if (text) {
        const hay = JSON.stringify(e).toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }, [events, filters, selectedTask]);

  if (!selectedTask) {
    return <div className="empty small">왼쪽에서 task를 선택하면 그 task의 이벤트가 표시됩니다.</div>;
  }

  return (
    <div className="feed">
      {filtered.length === 0 && <div className="empty small">이벤트 없음</div>}
      {filtered.map((e) => {
        const payload = e.kind === "message" ? e.body : e.kind === "blackboard" ? e.value : undefined;
        return (
          <div
            key={e.eventId}
            className={"feed-row " + e.kind}
            onClick={() => e.taskId && selectTask(e.taskId)}
            title={e.taskId ? `task: ${e.taskId}` : ""}
          >
            <span className="t">{fmtTime(e.ts)}</span>
            <span className={"badge " + e.kind}>{BADGE[e.kind]}</span>
            <span className="summary">{summarize(e)}</span>
            {e.tool && <span className="tool">{e.tool}</span>}
            {payload !== undefined && <span className="payload">{JSON.stringify(payload)}</span>}
          </div>
        );
      })}
    </div>
  );
}

import { useStore, type DelegateEntry } from "../store";

const AGENT_META: Record<string, { icon: string; name: string; cls: string }> = {
  hub: { icon: "📡", name: "HomeHub", cls: "hub" },
  pc:  { icon: "🖥️",  name: "PC",     cls: "pc"  },
  tv:  { icon: "📺", name: "TV",     cls: "tv"  },
};

function agentLabel(id: string) {
  const meta = AGENT_META[id];
  return meta ? `${meta.icon} ${meta.name}` : id;
}

function AgentChip({ id }: { id: string }) {
  const meta = AGENT_META[id];
  return <span className={`agent-chip ${meta?.cls ?? "unknown"}`}>{meta?.icon ?? "??"} {meta?.name ?? id}</span>;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function payloadPreview(p: unknown): string {
  if (p === undefined || p === null) return "";
  const s = typeof p === "string" ? p : JSON.stringify(p);
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

function DelegateItem({ entry }: { entry: DelegateEntry }) {
  const isDispatch = entry.phase === "dispatch";
  return (
    <div className={`delegate-entry ${entry.phase}`}>
      <div className="delegate-agents">
        <AgentChip id={entry.from} />
        <span className="delegate-phase-icon">{isDispatch ? "→" : "←"}</span>
        <AgentChip id={entry.to} />
        <span className={`delegate-phase ${entry.phase}`} style={{ marginLeft: "auto" }}>
          {isDispatch ? "dispatch" : "return"}
        </span>
      </div>
      {(!!entry.task || entry.payload !== undefined) && (
        <div className="delegate-task">
          {entry.task ?? payloadPreview(entry.payload)}
        </div>
      )}
      {entry.task && entry.payload !== undefined && (
        <div className="delegate-payload">{payloadPreview(entry.payload)}</div>
      )}
      <div className="delegate-time">{fmtTime(entry.ts)}</div>
    </div>
  );
}

export function DelegateLog() {
  const log = useStore((s) => s.delegateLog);
  const selectedTask = useStore((s) => s.selectedTask);

  const filtered = selectedTask
    ? log.filter((e) => !e.taskId || e.taskId === selectedTask)
    : log;

  return (
    <div className="delegate-log">
      {filtered.length === 0 ? (
        <div className="delegate-log-empty">
          {selectedTask ? "이 Task에 위임 없음" : "위임 대기 중…"}
        </div>
      ) : (
        filtered.map((entry) => <DelegateItem key={entry.id} entry={entry} />)
      )}
    </div>
  );
}

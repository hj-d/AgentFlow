import { useStore } from "../store";
import { EventFeed } from "./EventFeed";

const AGENT_META: Record<string, { cls: string }> = {
  hub: { cls: "hub" },
  pc:  { cls: "pc" },
  tv:  { cls: "tv" },
};

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

// ---- Task I/O Banner ----
function TaskBanner() {
  const taskIO = useStore((s) => s.taskIO);
  if (!taskIO) return null;

  const scenarioLabel = taskIO.scenario === "scenario-1" ? "S1" : taskIO.scenario === "scenario-2" ? "S2" : taskIO.scenario;

  return (
    <div className="task-io-banner">
      {taskIO.request && (
        <div className="task-io-input">
          <div className="task-io-label">
            Task Input
            {scenarioLabel && <span className="scenario-badge">{scenarioLabel}</span>}
          </div>
          <div className="task-io-text">{taskIO.request}</div>
        </div>
      )}
      {taskIO.result !== undefined && (
        <div className="task-io-output">
          <div className="task-io-label">Task Output</div>
          <div className="task-io-result">
            {typeof taskIO.result === "string"
              ? taskIO.result
              : JSON.stringify(taskIO.result, null, 0)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Blackboard Tab ----
function BlackboardTab() {
  const blackboard = useStore((s) => s.blackboard);
  const entries = Object.entries(blackboard).sort((a, b) => b[1].ts - a[1].ts);

  return (
    <div className="bb-list">
      {entries.length === 0 ? (
        <div className="bb-empty">Blackboard 비어있음</div>
      ) : (
        entries.map(([key, entry]) => {
          const val = entry.value === undefined ? "—" : typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
          return (
            <div key={key} className="bb-row">
              <span className="bb-key" title={key}>{key}</span>
              <span className="bb-val" title={val}>{val}</span>
              <div className="bb-meta">
                <span className={`bb-by ${AGENT_META[entry.by]?.cls ?? ""}`}>{entry.by}</span>
                <span className="bb-reads">{entry.reads > 0 ? `${entry.reads}r` : ""}</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ---- Notifications Tab ----
function NotiTab() {
  const notiLog = useStore((s) => s.notiLog);
  const selectedTask = useStore((s) => s.selectedTask);

  const filtered = selectedTask
    ? notiLog.filter((n) => !n.taskId || n.taskId === selectedTask)
    : notiLog;

  return (
    <div className="noti-list">
      {filtered.length === 0 ? (
        <div className="noti-empty">알림 없음</div>
      ) : (
        filtered.map((n) => (
          <div key={n.id} className={`noti-entry ${n.phase}`}>
            <div className="noti-icon">{n.phase === "broadcast" ? "📢" : "✅"}</div>
            <div className="noti-body">
              <div className="noti-header">
                <span className={`noti-phase ${n.phase}`}>{n.phase === "broadcast" ? "broadcast" : "ack"}</span>
                <span className={`agent-chip ${AGENT_META[n.from]?.cls ?? "unknown"}`} style={{ fontSize: 10 }}>{n.from}</span>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>→</span>
                {Array.isArray(n.to) ? (
                  n.to.map((t) => (
                    <span key={t} className={`agent-chip ${AGENT_META[t]?.cls ?? "unknown"}`} style={{ fontSize: 10 }}>{t}</span>
                  ))
                ) : (
                  <span className={`agent-chip ${AGENT_META[n.to as string]?.cls ?? "unknown"}`} style={{ fontSize: 10 }}>{n.to}</span>
                )}
                {n.key && <span className="noti-key">{n.key}</span>}
              </div>
              {n.message && <div className="noti-msg">{n.message}</div>}
              <div className="noti-time">{fmtTime(n.ts)}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ---- Tasks Tab ----
function TasksTab() {
  const tasks = useStore((s) => s.tasks);
  const tasksTotal = useStore((s) => s.tasksTotal);
  const selectedTask = useStore((s) => s.selectedTask);
  const selectTask = useStore((s) => s.selectTask);
  const deleteTask = useStore((s) => s.deleteTask);
  const clearSpace = useStore((s) => s.clearSpace);

  const list = Object.values(tasks).sort((a, b) => b.lastTs - a.lastTs);

  return (
    <>
      <div className="task-list-head">
        <span>{tasksTotal} tasks</span>
        <div className="task-list-actions">
          {selectedTask && (
            <button className="btn" onClick={() => selectTask(null)}>전체 보기</button>
          )}
          <button className="btn danger" onClick={() => clearSpace()}>전체 삭제</button>
        </div>
      </div>
      <div className="task-list">
        {list.length === 0 && <div className="empty">Task 없음 — 시뮬레이터를 실행하세요</div>}
        {list.map((t) => {
          const scenario = t.scenario;
          return (
            <div
              key={t.taskId}
              className={`task-row ${selectedTask === t.taskId ? "sel" : ""}`}
              onClick={() => selectTask(t.taskId)}
            >
              <div className="task-id">{t.taskId}</div>
              <div className="task-meta">
                {scenario && (
                  <span className={`task-scenario ${scenario}`}>
                    {scenario === "scenario-1" ? "S1" : scenario === "scenario-2" ? "S2" : scenario}
                  </span>
                )}
                <div className="task-counts">
                  <span title="delegates">↔{t.delegates}</span>
                  <span title="tools">⚙{t.tools}</span>
                  <span title="notis">🔔{t.notis}</span>
                </div>
                <span className="task-age">{fmtAge(t.lastTs)}</span>
                <button className="task-del" onClick={(ev) => { ev.stopPropagation(); deleteTask(t.taskId); }}>✕</button>
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
  const notiLog = useStore((s) => s.notiLog);
  const blackboard = useStore((s) => s.blackboard);
  const events = useStore((s) => s.events);
  const selectedTask = useStore((s) => s.selectedTask);

  const bbCount = Object.keys(blackboard).length;
  const notiCount = notiLog.length;
  const evCount = selectedTask ? events.filter((e) => e.taskId === selectedTask).length : events.length;

  return (
    <>
      <TaskBanner />
      <div className="info-tabs">
        {(["blackboard", "notis", "events", "tasks"] as const).map((tab) => {
          const count = tab === "blackboard" ? bbCount : tab === "notis" ? notiCount : tab === "events" ? evCount : undefined;
          const label = tab === "blackboard" ? "Blackboard" : tab === "notis" ? "Noti" : tab === "events" ? "Events" : "Tasks";
          return (
            <button
              key={tab}
              className={`info-tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab as never)}
            >
              {label}
              {count !== undefined && count > 0 && <span className="info-tab-count">{count}</span>}
            </button>
          );
        })}
      </div>
      <div className="info-content">
        {activeTab === "blackboard" && <BlackboardTab />}
        {activeTab === "notis"      && <NotiTab />}
        {activeTab === "events"     && <EventFeed />}
        {activeTab === "tasks"      && <TasksTab />}
      </div>
    </>
  );
}

import { useMemo } from "react";
import { useStore } from "../store";

function age(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 1) return "now";
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m";
}

export function TaskList() {
  const tasks = useStore((s) => s.tasks);
  const total = useStore((s) => s.tasksTotal);
  const selected = useStore((s) => s.selectedTask);
  const selectTask = useStore((s) => s.selectTask);

  const list = useMemo(() => Object.values(tasks).sort((a, b) => b.lastTs - a.lastTs), [tasks]);

  return (
    <div className="tasks">
      <div className="tasks-head">
        <span>{total} tasks</span>
        {selected && (
          <button className="chip" onClick={() => selectTask(null)}>
            전체 보기 ✕
          </button>
        )}
      </div>
      {list.length === 0 && <div className="empty small">task 없음</div>}
      {list.map((t) => (
        <div
          key={t.taskId}
          className={"task-row" + (selected === t.taskId ? " sel" : "")}
          onClick={() => selectTask(selected === t.taskId ? null : t.taskId)}
          title="클릭: 이 task의 흐름만 보기"
        >
          <span className="task-id">{t.taskId}</span>
          <span className="task-meta">
            <span className="badge message">{t.messages}M</span>
            <span className="badge blackboard">{t.blackboard}B</span>
            <span className="task-dev">{t.devices.length}dev</span>
            <span className="task-age">{age(t.lastTs)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

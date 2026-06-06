import { useStore } from "../store";

function fmtAge(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 1 ? "now" : s + "s";
}

export function BlackboardPanel() {
  const blackboard = useStore((s) => s.blackboard);
  const entries = Object.entries(blackboard).sort((a, b) => b[1].ts - a[1].ts);

  return (
    <div className="bb">
      {entries.length === 0 && <div className="empty small">블랙보드 비어있음</div>}
      {entries.map(([key, v]) => (
        <div key={key} className="bb-row">
          <div className="bb-key">{key}</div>
          <div className="bb-val">{JSON.stringify(v.value)}</div>
          <div className="bb-meta">
            <span>v{v.version ?? 0}</span>
            <span>↺{v.reads}</span>
            <span>{fmtAge(v.ts)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

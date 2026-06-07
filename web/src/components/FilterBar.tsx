import { useMemo } from "react";
import { useStore } from "../store";

export function FilterBar() {
  const agents = useStore((s) => s.agents);
  const filters = useStore((s) => s.filters);
  const setFilter = useStore((s) => s.setFilter);

  const showEdgeData = useStore((s) => s.showEdgeData);
  const setShowEdgeData = useStore((s) => s.setShowEdgeData);

  const devices = useMemo(() => [...new Set(Object.values(agents).map((a) => a.deviceId))].sort(), [agents]);
  const teams = useMemo(() => [...new Set(Object.values(agents).map((a) => a.teamId))].sort(), [agents]);

  return (
    <div className="filterbar">
      <select value={filters.device ?? ""} onChange={(e) => setFilter({ device: e.target.value || null })}>
        <option value="">all devices</option>
        {devices.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <select value={filters.team ?? ""} onChange={(e) => setFilter({ team: e.target.value || null })}>
        <option value="">all teams</option>
        {teams.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select value={filters.kind} onChange={(e) => setFilter({ kind: e.target.value as any })}>
        <option value="all">all events</option>
        <option value="message">messages</option>
        <option value="blackboard">blackboard</option>
        <option value="tool">tool use</option>
        <option value="agent">agent lifecycle</option>
      </select>
      <input
        placeholder="search payload…"
        value={filters.text}
        onChange={(e) => setFilter({ text: e.target.value })}
      />
      <label className="toggle">
        <input type="checkbox" checked={showEdgeData} onChange={(e) => setShowEdgeData(e.target.checked)} />
        엣지 데이터
      </label>
    </div>
  );
}

import { useEffect } from "react";
import { connect } from "./lib/ws";
import { useStore, REPLAY_INTERVAL_MS } from "./store";
import { DeviceTopology } from "./components/DeviceTopology";
import { DelegateLog } from "./components/DelegateLog";
import { InfoPanel } from "./components/InfoPanel";
import { SpaceSwitcher } from "./components/SpaceSwitcher";

export default function App() {
  const connected = useStore((s) => s.connected);
  const rate = useStore((s) => s.rate);
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const currentTask = useStore((s) => s.selectedTask);
  const selectTask = useStore((s) => s.selectTask);

  useEffect(() => connect(), []);

  useEffect(() => {
    const id = setInterval(() => {
      const s = useStore.getState();
      if (s.replayQueue.length) s.replayNext();
    }, REPLAY_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">🏠</span>
          <span className="brand-name">AgentFlow</span>
          <span className="brand-sub">Home Network</span>
        </div>
        <SpaceSwitcher />
        <div className="topbar-right">
          <span className={"conn-dot " + (connected ? "on" : "off")} />
          <span className="conn-label">{connected ? "connected" : "disconnected"}</span>
          {rate > 0 && <span className="rate-badge">{rate}/s</span>}
          {currentTask && (
            <button className="task-chip" onClick={() => selectTask(null)}>
              {currentTask} ✕
            </button>
          )}
          <button
            className={"pause-btn" + (paused ? " active" : "")}
            onClick={() => setPaused(!paused)}
          >
            {paused ? "▶" : "⏸"}
          </button>
        </div>
      </header>

      <main className="three-col">
        <section className="panel delegate-panel">
          <div className="panel-header">
            <span className="panel-title">Delegate Log</span>
            <span className="panel-hint">Agent 간 위임 내역</span>
          </div>
          <DelegateLog />
        </section>

        <section className="panel topology-panel">
          <div className="panel-header">
            <span className="panel-title">Network</span>
            {currentTask
              ? <span className="panel-hint task-tag">{currentTask}</span>
              : <span className="panel-hint">task를 선택하면 해당 흐름만 표시</span>
            }
          </div>
          <DeviceTopology />
        </section>

        <section className="panel info-panel">
          <InfoPanel />
        </section>
      </main>
    </div>
  );
}

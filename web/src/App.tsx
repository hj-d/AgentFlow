import { useEffect } from "react";
import { connect } from "./lib/ws";
import { useStore } from "./store";
import { Topology } from "./components/Topology";
import { EventFeed } from "./components/EventFeed";
import { BlackboardPanel } from "./components/BlackboardPanel";
import { TaskList } from "./components/TaskList";
import { SpaceSwitcher } from "./components/SpaceSwitcher";
import { FilterBar } from "./components/FilterBar";

export default function App() {
  const connected = useStore((s) => s.connected);
  const rate = useStore((s) => s.rate);
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const selectedTask = useStore((s) => s.selectedTask);
  const selectTask = useStore((s) => s.selectTask);

  useEffect(() => connect(), []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◈</span> AgentFlow
        </div>
        <SpaceSwitcher />
        <div className="status">
          <span className={"dot " + (connected ? "on" : "off")} />
          {connected ? "connected" : "disconnected"}
          <span className="rate">{rate}/s</span>
          {selectedTask ? (
            <button className="chip" onClick={() => selectTask(null)}>
              task: {selectedTask} ✕
            </button>
          ) : (
            <span className="hint">task 선택 시 그 흐름만 표시</span>
          )}
          <button className={"btn" + (paused ? " active" : "")} onClick={() => setPaused(!paused)}>
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
        </div>
      </header>

      <FilterBar />

      <main className="grid">
        <section className="panel topology-panel">
          <h2>Topology · {selectedTask ? `task ${selectedTask}` : "전체 (task를 선택하세요)"}</h2>
          <Topology />
        </section>

        <section className="panel tasks-panel">
          <h2>Tasks</h2>
          <TaskList />
        </section>

        <section className="panel feed-panel">
          <h2>Live Events</h2>
          <EventFeed />
        </section>

        <section className="panel bb-panel">
          <h2>Blackboard</h2>
          <BlackboardPanel />
        </section>
      </main>
    </div>
  );
}

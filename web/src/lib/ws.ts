import type { ServerMessage } from "../types";
import { useStore } from "../store";

function wsUrl(): string {
  const override = (window as any).__AGENTFLOW_WS__ as string | undefined;
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const port = import.meta.env.VITE_SERVER_PORT ?? "3001";
  return `${proto}://${location.hostname}:${port}/ws`;
}

/** Workspace comes from the URL (?space=alice), so each link is an isolated page. */
export function spaceFromUrl(): string {
  return new URLSearchParams(location.search).get("space") || "default";
}

export function connect(): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const sendSubscribe = (taskId: string | null) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribeTask", taskId }));
    }
  };
  const sendJoin = (space: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join", space }));
    }
  };
  useStore.getState().setSubscribe(sendSubscribe);
  useStore.getState().setJoin(sendJoin);
  // reflect the URL's workspace as the current space (without re-sending derived state)
  useStore.setState({ space: spaceFromUrl() });

  function open() {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      useStore.getState().setConnected(true);
      // re-assert workspace + task subscription after (re)connect
      sendJoin(useStore.getState().space);
      sendSubscribe(useStore.getState().selectedTask);
    };
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      if (!closed) retry = setTimeout(open, 1500);
    };
    ws.onerror = () => ws?.close();
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const s = useStore.getState();
      if (msg.type === "snapshot") s.loadSnapshot(msg.events);
      else if (msg.type === "event") s.ingest(msg.event);
      else if (msg.type === "tasks") s.setTasks(msg.tasks, msg.total);
      else if (msg.type === "spaces") s.setSpaces(msg.spaces);
      else if (msg.type === "stats") s.setRate(msg.rate);
    };
  }

  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

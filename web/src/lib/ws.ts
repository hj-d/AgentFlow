import type { ServerMessage } from "../types";
import { useStore } from "../store";

// Derive collector WS URL. In Docker, server is exposed on :3001 of the same host.
function wsUrl(): string {
  const override = (window as any).__AGENTFLOW_WS__ as string | undefined;
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const port = import.meta.env.VITE_SERVER_PORT ?? "3001";
  return `${proto}://${location.hostname}:${port}/ws`;
}

export function connect(): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // tell the server which task's detail to stream (null = none)
  const sendSubscribe = (taskId: string | null) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribeTask", taskId }));
    }
  };
  useStore.getState().setSubscribe(sendSubscribe);

  function open() {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      useStore.getState().setConnected(true);
      // re-assert current subscription after (re)connect
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

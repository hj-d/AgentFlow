"""
AgentFlow client SDK for Python (stdlib only, drop-in).

Add emit calls at your message-server relay point and at blackboard read/write.
Events are batched and sent from a background thread; a collector outage never
raises into your agent logic.

    af = AgentFlowClient(url="http://collector:3001/ingest", device_id="edge-1")
    af.message(team_id="planner", agent_id=src, frm=src, to=dst,
               msg_type="task", trace_id=tid, body={"x": 1})
    af.blackboard_write(team_id="planner", agent_id=a, key=k, value=v, trace_id=tid)
    af.blackboard_read(team_id="planner", agent_id=a, key=k, trace_id=tid)
    af.close()  # flush + stop on shutdown
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any, Callable, Optional


class AgentFlowClient:
    def __init__(
        self,
        url: str,
        device_id: Optional[str] = None,
        team_id: Optional[str] = None,
        batch_size: int = 20,
        flush_interval: float = 0.25,
        max_queue: int = 5000,
        timeout: float = 0.5,
        on_error: Optional[Callable[[Exception], None]] = None,
        sender: Optional[Callable[[str, bytes], None]] = None,
    ) -> None:
        self._url = url
        self._device_id = device_id
        self._team_id = team_id
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._max_queue = max_queue
        self._timeout = timeout
        self._on_error = on_error
        self._sender = sender or self._http_send

        self._queue: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        if flush_interval > 0:
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()

    # ---- public API ----
    def emit(self, event: dict[str, Any]) -> None:
        """Enqueue any event dict. Never raises."""
        event.setdefault("deviceId", self._device_id)
        event.setdefault("teamId", self._team_id)
        flush_now = False
        with self._lock:
            self._queue.append(event)
            if len(self._queue) > self._max_queue:
                del self._queue[: len(self._queue) - self._max_queue]
            if len(self._queue) >= self._batch_size:
                flush_now = True
        if flush_now:
            self.flush()

    def online(
        self,
        agent_id: str,
        team_id: Optional[str] = None,
        device_id: Optional[str] = None,
        role: Optional[str] = None,
        capabilities: Optional[list] = None,
        trace_id: Optional[str] = None,
    ) -> None:
        """Announce an agent has started — call once on agent startup."""
        self.emit(
            _drop_none(
                {
                    "kind": "agent",
                    "status": "online",
                    "deviceId": device_id,
                    "teamId": team_id,
                    "agentId": agent_id,
                    "role": role,
                    "capabilities": capabilities,
                    "traceId": trace_id,
                }
            )
        )

    def offline(
        self,
        agent_id: str,
        team_id: Optional[str] = None,
        device_id: Optional[str] = None,
    ) -> None:
        """Announce an agent has stopped."""
        self.emit(
            _drop_none(
                {
                    "kind": "agent",
                    "status": "offline",
                    "deviceId": device_id,
                    "teamId": team_id,
                    "agentId": agent_id,
                }
            )
        )

    def message(
        self,
        agent_id: str,
        frm: str,
        to: Optional[str],
        team_id: Optional[str] = None,
        device_id: Optional[str] = None,
        op: str = "send",
        msg_type: Optional[str] = None,
        body: Any = None,
        size: Optional[int] = None,
        tool: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> None:
        self.emit(
            _drop_none(
                {
                    "kind": "message",
                    "deviceId": device_id,
                    "teamId": team_id,
                    "agentId": agent_id,
                    "op": op,
                    "from": frm,
                    "to": to,
                    "msgType": msg_type,
                    "body": body,
                    "size": size,
                    "tool": tool,
                    "taskId": task_id,
                    "traceId": trace_id,
                    "correlationId": correlation_id,
                }
            )
        )

    def blackboard_write(
        self,
        agent_id: str,
        key: str,
        value: Any = None,
        team_id: Optional[str] = None,
        device_id: Optional[str] = None,
        version: Optional[int] = None,
        tool: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
    ) -> None:
        self.emit(
            _drop_none(
                {
                    "kind": "blackboard",
                    "op": "write",
                    "deviceId": device_id,
                    "teamId": team_id,
                    "agentId": agent_id,
                    "key": key,
                    "value": value,
                    "version": version,
                    "tool": tool,
                    "taskId": task_id,
                    "traceId": trace_id,
                }
            )
        )

    def blackboard_read(
        self,
        agent_id: str,
        key: str,
        team_id: Optional[str] = None,
        device_id: Optional[str] = None,
        tool: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
    ) -> None:
        self.emit(
            _drop_none(
                {
                    "kind": "blackboard",
                    "op": "read",
                    "deviceId": device_id,
                    "teamId": team_id,
                    "agentId": agent_id,
                    "key": key,
                    "tool": tool,
                    "taskId": task_id,
                    "traceId": trace_id,
                }
            )
        )

    def flush(self) -> None:
        with self._lock:
            if not self._queue:
                return
            batch = self._queue
            self._queue = []
        try:
            self._sender(self._url, json.dumps(batch).encode("utf-8"))
        except Exception as err:  # re-queue (bounded) on failure
            with self._lock:
                self._queue = (batch + self._queue)[-self._max_queue :]
            if self._on_error:
                self._on_error(err)

    @property
    def pending(self) -> int:
        with self._lock:
            return len(self._queue)

    def close(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        self.flush()

    # ---- internals ----
    def _loop(self) -> None:
        while not self._stop.wait(self._flush_interval):
            self.flush()

    def _http_send(self, url: str, body: bytes) -> None:
        req = urllib.request.Request(
            url, data=body, headers={"content-type": "application/json"}, method="POST"
        )
        urllib.request.urlopen(req, timeout=self._timeout).close()


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}

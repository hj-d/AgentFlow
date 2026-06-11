"""
AgentFlow SDK — Python (stdlib only, drop-in, zero dependencies).

7 event kinds: agent · tool · delegate · blackboard · noti · task · message
Events are batched and sent from a background thread; a collector outage
never raises into your agent logic.

    af = AgentFlowClient(url="http://collector:3001/ingest", agent_id="hub")

    af.agent_start(role="orchestrator", label="HomeHub")
    af.dispatch(frm="hub", to="pc", task="영상 편집해줘", task_id="t-1")
    af.tool_start(tool="edit_video", task_id="t-1")
    af.bb_write(key="video_result", value={"file": "out.mp4"}, task_id="t-1")
    af.broadcast(frm="hub", to=["pc","tv"], key="task_req", task_id="t-1")
    af.task_input(request="영상 만들어줘", task_id="t-1")
    af.close()  # flush + stop on shutdown
"""

from __future__ import annotations

import json
import threading
import urllib.request
from typing import Any, Callable, List, Literal, Optional, Union


class AgentFlowClient:
    def __init__(
        self,
        url: str,
        space: Optional[str] = None,
        agent_id: Optional[str] = None,
        batch_size: int = 20,
        flush_interval: float = 0.25,
        max_queue: int = 5000,
        timeout: float = 0.5,
        on_error: Optional[Callable[[Exception], None]] = None,
        sender: Optional[Callable[[str, bytes], None]] = None,
    ) -> None:
        self._url = url
        self._space = space
        self._agent_id = agent_id
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._max_queue = max_queue
        self._timeout = timeout
        self._on_error = on_error
        self._sender = sender or self._http_send

        self._queue: List[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        if flush_interval > 0:
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()

    # ---- public API ----

    def emit(self, event: dict[str, Any]) -> None:
        """Enqueue any event dict. Never raises."""
        if self._space is not None:
            event.setdefault("space", self._space)
        if self._agent_id is not None:
            event.setdefault("agentId", self._agent_id)
        flush_now = False
        with self._lock:
            self._queue.append(event)
            if len(self._queue) > self._max_queue:
                del self._queue[: len(self._queue) - self._max_queue]
            if len(self._queue) >= self._batch_size:
                flush_now = True
        if flush_now:
            self.flush()

    # ---- Agent ----

    def agent_start(
        self,
        agent_id: Optional[str] = None,
        role: Optional[str] = None,
        label: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Agent comes online — call at startup so it appears in the topology immediately."""
        self.emit(_drop_none({
            "kind": "agent", "phase": "start",
            "agentId": agent_id, "role": role, "label": label,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    def agent_end(
        self,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Agent goes offline."""
        self.emit(_drop_none({
            "kind": "agent", "phase": "end",
            "agentId": agent_id, "taskId": task_id,
            "traceId": trace_id, "causedBy": caused_by,
        }))

    # ---- Tool ----

    def tool_start(
        self,
        tool: str,
        agent_id: Optional[str] = None,
        input: Any = None,
        summary: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Mark the agent as busy with a tool."""
        self.emit(_drop_none({
            "kind": "tool", "phase": "start",
            "agentId": agent_id, "tool": tool,
            "input": input, "summary": summary,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    def tool_end(
        self,
        tool: str,
        agent_id: Optional[str] = None,
        status: Optional[Literal["ok", "error"]] = None,
        output: Any = None,
        summary: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Release the busy state and record the result."""
        self.emit(_drop_none({
            "kind": "tool", "phase": "end",
            "agentId": agent_id, "tool": tool,
            "status": status, "output": output, "summary": summary,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    # ---- Delegate ----

    def dispatch(
        self,
        frm: str,
        to: str,
        agent_id: Optional[str] = None,
        task: Optional[str] = None,
        payload: Any = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Dispatch work to another agent."""
        self.emit(_drop_none({
            "kind": "delegate", "phase": "dispatch",
            "agentId": agent_id or frm, "from": frm, "to": to,
            "task": task, "payload": payload,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    def delegate_return(
        self,
        frm: str,
        to: str,
        agent_id: Optional[str] = None,
        task: Optional[str] = None,
        payload: Any = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Return results to the delegating agent."""
        self.emit(_drop_none({
            "kind": "delegate", "phase": "return",
            "agentId": agent_id or frm, "from": frm, "to": to,
            "task": task, "payload": payload,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    # ---- Blackboard ----

    def bb_write(
        self,
        key: str,
        value: Any = None,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Write a value to the shared blackboard."""
        self.emit(_drop_none({
            "kind": "blackboard", "op": "write",
            "agentId": agent_id, "key": key, "value": value,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    def bb_read(
        self,
        key: str,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Read a value from the shared blackboard."""
        self.emit(_drop_none({
            "kind": "blackboard", "op": "read",
            "agentId": agent_id, "key": key,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    # ---- Noti ----

    def broadcast(
        self,
        frm: str,
        to: Union[str, List[str]],
        agent_id: Optional[str] = None,
        key: Optional[str] = None,
        message: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Broadcast to agents: 'check the blackboard at `key`'."""
        self.emit(_drop_none({
            "kind": "noti", "phase": "broadcast",
            "agentId": agent_id or frm, "from": frm, "to": to,
            "key": key, "message": message,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    def ack(
        self,
        frm: str,
        to: str,
        agent_id: Optional[str] = None,
        key: Optional[str] = None,
        message: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Acknowledge a broadcast: 'I've read and responded to `key`'."""
        self.emit(_drop_none({
            "kind": "noti", "phase": "ack",
            "agentId": agent_id or frm, "from": frm, "to": to,
            "key": key, "message": message,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    # ---- Task (Hub only) ----

    def task_input(
        self,
        request: Optional[str] = None,
        agent_id: Optional[str] = None,
        scenario: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Hub receives a task from the user."""
        self.emit(_drop_none({
            "kind": "task", "phase": "input",
            "agentId": agent_id, "request": request,
            "scenario": scenario, "taskId": task_id,
            "traceId": trace_id, "causedBy": caused_by,
        }))

    def task_output(
        self,
        result: Any = None,
        agent_id: Optional[str] = None,
        scenario: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Hub returns the final result to the user."""
        self.emit(_drop_none({
            "kind": "task", "phase": "output",
            "agentId": agent_id, "result": result,
            "scenario": scenario, "taskId": task_id,
            "traceId": trace_id, "causedBy": caused_by,
        }))

    # ---- Message (agent internal narration) ----

    def message(
        self,
        title: str,
        content: str,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        caused_by: Optional[str] = None,
    ) -> None:
        """Agent narrates what it's doing — shown in the Agent 대화 panel."""
        self.emit(_drop_none({
            "kind": "message",
            "agentId": agent_id, "title": title, "content": content,
            "taskId": task_id, "traceId": trace_id, "causedBy": caused_by,
        }))

    # ---- flush / close ----

    def flush(self) -> None:
        with self._lock:
            if not self._queue:
                return
            batch = self._queue
            self._queue = []
        try:
            self._sender(self._url, json.dumps(batch).encode("utf-8"))
        except Exception as err:
            with self._lock:
                self._queue = (batch + self._queue)[-self._max_queue:]
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

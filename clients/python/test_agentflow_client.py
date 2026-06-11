"""Tests for the Python AgentFlow client. Run:  python3 -m unittest -v
Uses the injectable `sender` so no network/collector is required."""

import json
import time
import unittest

from agentflow_client import AgentFlowClient, _drop_none


def capturing_client(**kwargs):
    """Client with a fake sender that records decoded batches. Timer disabled."""
    batches = []

    def sender(_url, body):
        batches.append(json.loads(body.decode("utf-8")))

    kwargs.setdefault("flush_interval", 0)
    client = AgentFlowClient(url="x", sender=sender, **kwargs)
    return client, batches


def is_valid_for_server(e):
    """Mirror of isValidInput in server/src/ingest.ts — the collector's contract."""
    if not isinstance(e, dict):
        return False
    if not isinstance(e.get("agentId"), str) or not e["agentId"]:
        return False
    kind = e.get("kind")
    if kind == "agent":
        return e.get("phase") in ("start", "end")
    if kind == "tool":
        return isinstance(e.get("tool"), str) and bool(e["tool"]) and \
               e.get("phase") in ("start", "end")
    if kind == "delegate":
        return e.get("phase") in ("dispatch", "return") and \
               isinstance(e.get("from"), str) and bool(e["from"]) and \
               isinstance(e.get("to"), str) and bool(e["to"])
    if kind == "blackboard":
        return e.get("op") in ("read", "write") and \
               isinstance(e.get("key"), str) and bool(e["key"])
    if kind == "noti":
        return e.get("phase") in ("broadcast", "ack") and \
               isinstance(e.get("from"), str) and bool(e["from"]) and \
               e.get("to") is not None
    if kind == "task":
        return e.get("phase") in ("input", "output")
    if kind == "message":
        return isinstance(e.get("title"), str) and bool(e["title"]) and \
               isinstance(e.get("content"), str)
    return False


class TestEventShapes(unittest.TestCase):
    """Exact JSON produced for each of the 7 kinds, field-by-field."""

    def test_agent_start_and_end_exact(self):
        af, batches = capturing_client(agent_id="hub", space="home", batch_size=2)
        af.agent_start(role="orchestrator", label="HomeHub",
                       task_id="t-1", trace_id="tr-1", caused_by="ev-0")
        af.agent_end(task_id="t-1", trace_id="tr-1", caused_by="ev-1")
        start, end = batches[0]
        self.assertEqual(start, {
            "kind": "agent", "phase": "start", "agentId": "hub", "space": "home",
            "role": "orchestrator", "label": "HomeHub",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-0",
        })
        self.assertEqual(end, {
            "kind": "agent", "phase": "end", "agentId": "hub", "space": "home",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-1",
        })

    def test_tool_start_and_end_exact(self):
        af, batches = capturing_client(agent_id="pc", batch_size=2)
        af.tool_start(tool="edit_video", input={"photos": 24}, summary="편집 시작",
                      task_id="t-1", trace_id="tr-1", caused_by="ev-1")
        af.tool_end(tool="edit_video", status="ok", output={"file": "out.mp4"},
                    summary="3분 영상 완성", task_id="t-1", trace_id="tr-1", caused_by="ev-2")
        start, end = batches[0]
        self.assertEqual(start, {
            "kind": "tool", "phase": "start", "agentId": "pc", "tool": "edit_video",
            "input": {"photos": 24}, "summary": "편집 시작",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-1",
        })
        self.assertEqual(end, {
            "kind": "tool", "phase": "end", "agentId": "pc", "tool": "edit_video",
            "status": "ok", "output": {"file": "out.mp4"}, "summary": "3분 영상 완성",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-2",
        })

    def test_tool_end_error_status(self):
        af, batches = capturing_client(agent_id="pc", batch_size=1)
        af.tool_end(tool="edit_video", status="error", summary="디스크 부족")
        e = batches[0][0]
        self.assertEqual(e["status"], "error")
        self.assertEqual(e["summary"], "디스크 부족")
        self.assertNotIn("output", e)

    def test_delegate_dispatch_and_return_exact(self):
        af, batches = capturing_client(batch_size=2)
        af.dispatch(frm="hub", to="pc", task="영상 편집해줘", payload={"n": 1},
                    task_id="t-1", trace_id="tr-1", caused_by="ev-1")
        af.delegate_return(frm="pc", to="hub", task="영상 편집해줘",
                           payload={"file": "out.mp4"},
                           task_id="t-1", trace_id="tr-1", caused_by="ev-2")
        d, r = batches[0]
        self.assertEqual(d, {
            "kind": "delegate", "phase": "dispatch", "agentId": "hub",
            "from": "hub", "to": "pc", "task": "영상 편집해줘", "payload": {"n": 1},
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-1",
        })
        self.assertEqual(r, {
            "kind": "delegate", "phase": "return", "agentId": "pc",
            "from": "pc", "to": "hub", "task": "영상 편집해줘",
            "payload": {"file": "out.mp4"},
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-2",
        })

    def test_delegate_agent_id_defaults_to_frm_and_is_overridable(self):
        af, batches = capturing_client(batch_size=2)
        af.dispatch(frm="hub", to="pc")
        af.dispatch(frm="hub", to="pc", agent_id="observer")
        self.assertEqual(batches[0][0]["agentId"], "hub")
        self.assertEqual(batches[0][1]["agentId"], "observer")

    def test_blackboard_write_and_read_exact(self):
        af, batches = capturing_client(agent_id="tv", batch_size=2)
        af.bb_write(key="music_preferences", value={"genre": "K-Pop"},
                    task_id="t-1", trace_id="tr-1", caused_by="ev-1")
        af.bb_read(key="music_preferences", agent_id="hub",
                   task_id="t-1", trace_id="tr-1", caused_by="ev-2")
        w, r = batches[0]
        self.assertEqual(w, {
            "kind": "blackboard", "op": "write", "agentId": "tv",
            "key": "music_preferences", "value": {"genre": "K-Pop"},
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-1",
        })
        self.assertEqual(r, {
            "kind": "blackboard", "op": "read", "agentId": "hub",
            "key": "music_preferences",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-2",
        })
        self.assertNotIn("value", r)  # read carries no value

    def test_noti_broadcast_and_ack_exact(self):
        af, batches = capturing_client(batch_size=2)
        af.broadcast(frm="hub", to=["pc", "tv"], key="task_requirements",
                     message="능력 목록 작성해줘",
                     task_id="t-1", trace_id="tr-1", caused_by="ev-1")
        af.ack(frm="pc", to="hub", key="capabilities_pc", message="작성 완료",
               task_id="t-1", trace_id="tr-1", caused_by="ev-2")
        b, a = batches[0]
        self.assertEqual(b, {
            "kind": "noti", "phase": "broadcast", "agentId": "hub",
            "from": "hub", "to": ["pc", "tv"],
            "key": "task_requirements", "message": "능력 목록 작성해줘",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-1",
        })
        self.assertEqual(a, {
            "kind": "noti", "phase": "ack", "agentId": "pc",
            "from": "pc", "to": "hub",
            "key": "capabilities_pc", "message": "작성 완료",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-2",
        })

    def test_task_input_and_output_exact(self):
        af, batches = capturing_client(agent_id="hub", batch_size=2)
        af.task_input(request="엄마 생일 영상 만들어줘", scenario="scenario-1",
                      task_id="t-1", trace_id="tr-1")
        af.task_output(result={"video": "birthday.mp4"},
                       task_id="t-1", trace_id="tr-1", caused_by="ev-9")
        i, o = batches[0]
        self.assertEqual(i, {
            "kind": "task", "phase": "input", "agentId": "hub",
            "request": "엄마 생일 영상 만들어줘", "scenario": "scenario-1",
            "taskId": "t-1", "traceId": "tr-1",
        })
        self.assertEqual(o, {
            "kind": "task", "phase": "output", "agentId": "hub",
            "result": {"video": "birthday.mp4"},
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-9",
        })

    def test_message_exact(self):
        af, batches = capturing_client(agent_id="hub", batch_size=1)
        af.message(title="계획 수립 중", content="TV→음악, PC→편집 순으로 처리할게.",
                   task_id="t-1", trace_id="tr-1", caused_by="ev-1")
        self.assertEqual(batches[0][0], {
            "kind": "message", "agentId": "hub",
            "title": "계획 수립 중", "content": "TV→음악, PC→편집 순으로 처리할게.",
            "taskId": "t-1", "traceId": "tr-1", "causedBy": "ev-1",
        })

    def test_all_methods_pass_server_validation(self):
        # Every convenience method, called with minimal args, must produce an
        # event the collector accepts (mirrors server/src/ingest.ts).
        af, batches = capturing_client(agent_id="hub", batch_size=1)
        af.agent_start()
        af.agent_end()
        af.tool_start(tool="search")
        af.tool_end(tool="search")
        af.dispatch(frm="hub", to="pc")
        af.delegate_return(frm="pc", to="hub")
        af.bb_write(key="k")
        af.bb_read(key="k")
        af.broadcast(frm="hub", to=["pc", "tv"])
        af.ack(frm="pc", to="hub")
        af.task_input()
        af.task_output()
        af.message(title="t", content="c")
        events = [e for batch in batches for e in batch]
        self.assertEqual(len(events), 13)
        kinds = {e["kind"] for e in events}
        self.assertEqual(kinds, {"agent", "tool", "delegate", "blackboard",
                                 "noti", "task", "message"})
        for e in events:
            self.assertTrue(is_valid_for_server(e), e)

    def test_defaults_applied_and_overridable(self):
        af, batches = capturing_client(agent_id="a-def", space="s-def", batch_size=1)
        af.message(title="t", content="c")
        af.message(title="t", content="c", agent_id="a-over")
        self.assertEqual(batches[0][0]["agentId"], "a-def")
        self.assertEqual(batches[0][0]["space"], "s-def")
        self.assertEqual(batches[1][0]["agentId"], "a-over")
        self.assertEqual(batches[1][0]["space"], "s-def")

    def test_unset_optionals_stripped(self):
        af, batches = capturing_client(agent_id="a", batch_size=1)
        af.tool_start(tool="python")
        e = batches[0][0]
        self.assertEqual(e, {"kind": "tool", "phase": "start",
                             "agentId": "a", "tool": "python"})
        for absent in ("input", "summary", "taskId", "traceId", "causedBy", "space"):
            self.assertNotIn(absent, e)

    def test_emit_preserves_explicit_none(self):
        # low-level emit() is raw: it must not strip an explicit None value
        af, batches = capturing_client(agent_id="a", batch_size=1)
        af.emit({"kind": "task", "phase": "output", "result": None})
        e = batches[0][0]
        self.assertIn("result", e)
        self.assertIsNone(e["result"])
        self.assertEqual(e["agentId"], "a")  # default still applied


class TestBatching(unittest.TestCase):
    def test_no_flush_until_batch_size(self):
        af, batches = capturing_client(agent_id="a", batch_size=3)
        af.message(title="t", content="c")
        af.message(title="t", content="c")
        self.assertEqual(batches, [])
        self.assertEqual(af.pending, 2)

    def test_auto_flush_on_batch_size(self):
        af, batches = capturing_client(agent_id="a", batch_size=2)
        af.message(title="t", content="c")
        af.message(title="t", content="c")
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 2)
        self.assertEqual(af.pending, 0)

    def test_manual_flush_sends_queue(self):
        af, batches = capturing_client(agent_id="a", batch_size=99)
        af.message(title="t", content="c")
        af.flush()
        self.assertEqual(len(batches), 1)
        self.assertEqual(af.pending, 0)

    def test_flush_with_empty_queue_sends_nothing(self):
        af, batches = capturing_client(agent_id="a")
        af.flush()
        self.assertEqual(batches, [])

    def test_background_thread_flushes(self):
        batches = []

        def sender(_url, body):
            batches.append(json.loads(body.decode("utf-8")))

        af = AgentFlowClient(url="x", agent_id="a", batch_size=99,
                             flush_interval=0.02, sender=sender)
        try:
            af.message(title="bg", content="c")
            deadline = time.monotonic() + 2.0
            while not batches and time.monotonic() < deadline:
                time.sleep(0.01)
        finally:
            af.close()
        self.assertTrue(batches, "background thread never flushed")
        self.assertEqual(batches[0][0]["title"], "bg")

    def test_close_flushes(self):
        af, batches = capturing_client(agent_id="a", batch_size=99)
        af.message(title="t", content="c")
        af.close()
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 1)


class TestFailureHandling(unittest.TestCase):
    def test_requeue_and_on_error(self):
        errors = []

        def bad_sender(_url, _body):
            raise RuntimeError("collector down")

        af = AgentFlowClient(url="x", agent_id="a", batch_size=10,
                             flush_interval=0, sender=bad_sender,
                             on_error=errors.append)
        af.message(title="t", content="c")
        af.flush()
        self.assertEqual(len(errors), 1)
        self.assertEqual(af.pending, 1)  # preserved for retry

    def test_requeue_preserves_order_then_retries(self):
        batches, errors, fail = [], [], [True]

        def flaky(_url, body):
            if fail[0]:
                fail[0] = False
                raise RuntimeError("collector down")
            batches.append(json.loads(body.decode("utf-8")))

        af = AgentFlowClient(url="x", agent_id="a", batch_size=99,
                             flush_interval=0, sender=flaky,
                             on_error=errors.append)
        af.message(title="m0", content="c")
        af.message(title="m1", content="c")
        af.flush()  # fails — both events re-queued in order
        self.assertEqual(af.pending, 2)
        af.message(title="m2", content="c")
        af.flush()  # succeeds — old events go first
        self.assertEqual([e["title"] for e in batches[0]], ["m0", "m1", "m2"])
        self.assertEqual(af.pending, 0)
        self.assertEqual(len(errors), 1)

    def test_emit_never_raises_when_sender_fails(self):
        def bad_sender(_url, _body):
            raise RuntimeError("collector down")

        af = AgentFlowClient(url="x", agent_id="a", batch_size=1,
                             flush_interval=0, sender=bad_sender)
        try:
            af.message(title="t", content="c")  # batch_size=1 → flush inside emit
        except Exception as err:  # noqa: BLE001
            self.fail(f"emit raised into agent code: {err!r}")
        self.assertEqual(af.pending, 1)

    def test_max_queue_drops_oldest(self):
        af, batches = capturing_client(agent_id="a", batch_size=99999, max_queue=5)
        for i in range(20):
            af.message(title=f"m{i}", content="c")
        self.assertEqual(af.pending, 5)
        af.flush()
        self.assertEqual([e["title"] for e in batches[0]],
                         ["m15", "m16", "m17", "m18", "m19"])

    def test_requeue_respects_max_queue(self):
        # If events arrive while a send is failing, the re-queued total is
        # capped at max_queue, dropping the oldest.
        holder = {}

        def bad_sender(_url, _body):
            holder["af"].message(title="during", content="c")
            raise RuntimeError("collector down")

        af = AgentFlowClient(url="x", agent_id="a", batch_size=99,
                             flush_interval=0, max_queue=2, sender=bad_sender)
        holder["af"] = af
        af.message(title="m0", content="c")
        af.message(title="m1", content="c")
        af.flush()  # batch [m0, m1] + queued [during] → capped to 2 newest
        self.assertEqual(af.pending, 2)


class TestHelpers(unittest.TestCase):
    def test_drop_none_removes_none_only(self):
        self.assertEqual(_drop_none({"a": 1, "b": None, "c": 0, "d": False}),
                         {"a": 1, "c": 0, "d": False})


if __name__ == "__main__":
    unittest.main(verbosity=2)

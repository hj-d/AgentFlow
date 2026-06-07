"""Tests for the Python AgentFlow client. Run:  python3 -m unittest -v
Uses the injectable `sender` so no network/collector is required."""

import json
import unittest

from agentflow_client import AgentFlowClient, _drop_none


def capturing_client(**kwargs):
    """Client with a fake sender that records decoded batches. Timer disabled."""
    batches = []

    def sender(_url, body):
        batches.append(json.loads(body.decode("utf-8")))

    client = AgentFlowClient(url="x", flush_interval=0, sender=sender, **kwargs)
    return client, batches


class TestBatching(unittest.TestCase):
    def test_no_flush_until_batch_size(self):
        af, batches = capturing_client(device_id="d1", batch_size=3)
        af.message(agent_id="a", frm="a", to="b", team_id="t")
        af.message(agent_id="a", frm="a", to="b", team_id="t")
        self.assertEqual(batches, [])
        self.assertEqual(af.pending, 2)

    def test_auto_flush_on_batch_size(self):
        af, batches = capturing_client(device_id="d1", batch_size=2)
        af.message(agent_id="a", frm="a", to="b", team_id="t")
        af.message(agent_id="a", frm="a", to="b", team_id="t")
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 2)

    def test_defaults_applied_and_overridable(self):
        af, batches = capturing_client(device_id="d-def", team_id="t-def", batch_size=1)
        af.message(agent_id="a", frm="a", to="b")
        af.message(agent_id="a", frm="a", to="b", device_id="d-over")
        self.assertEqual(batches[0][0]["deviceId"], "d-def")
        self.assertEqual(batches[0][0]["teamId"], "t-def")
        self.assertEqual(batches[1][0]["deviceId"], "d-over")

    def test_message_shape(self):
        af, batches = capturing_client(device_id="d1", team_id="t", batch_size=1)
        af.message(agent_id="a1", frm="a1", to="a2", msg_type="task", trace_id="tr", body={"n": 1})
        e = batches[0][0]
        self.assertEqual(e["kind"], "message")
        self.assertEqual(e["op"], "send")
        self.assertEqual(e["from"], "a1")
        self.assertEqual(e["to"], "a2")
        self.assertEqual(e["msgType"], "task")
        self.assertEqual(e["traceId"], "tr")
        self.assertEqual(e["body"], {"n": 1})

    def test_blackboard_write_and_read_shape(self):
        af, batches = capturing_client(device_id="d1", team_id="t", batch_size=2)
        af.blackboard_write(agent_id="a1", key="k", value={"v": 2}, trace_id="tr")
        af.blackboard_read(agent_id="a2", key="k", trace_id="tr")
        w, r = batches[0]
        self.assertEqual(w["kind"], "blackboard")
        self.assertEqual(w["op"], "write")
        self.assertEqual(w["value"], {"v": 2})
        self.assertEqual(r["op"], "read")
        self.assertNotIn("value", r)  # read carries no value

    def test_agent_online_offline_shape(self):
        af, batches = capturing_client(device_id="d1", team_id="t", batch_size=2)
        af.online(agent_id="a1", role="planner")
        af.offline(agent_id="a1")
        on, off = batches[0]
        self.assertEqual(on["kind"], "agent")
        self.assertEqual(on["status"], "online")
        self.assertEqual(on["agentId"], "a1")
        self.assertEqual(on["role"], "planner")
        self.assertEqual(on["deviceId"], "d1")
        self.assertEqual(off["status"], "offline")
        self.assertNotIn("role", off)

    def test_tool_shape(self):
        af, batches = capturing_client(device_id="d1", team_id="t", batch_size=2)
        af.tool(agent_id="a1", tool="search", phase="start", task_id="tk")
        af.tool(agent_id="a1", tool="search", phase="end", status="ok", summary="found 3", task_id="tk")
        start, end = batches[0]
        self.assertEqual(start["kind"], "tool")
        self.assertEqual(start["tool"], "search")
        self.assertEqual(start["phase"], "start")
        self.assertEqual(start["agentId"], "a1")
        self.assertEqual(start["taskId"], "tk")
        self.assertEqual(end["phase"], "end")
        self.assertEqual(end["status"], "ok")
        self.assertEqual(end["summary"], "found 3")

    def test_tool_drops_unset_optionals(self):
        af, batches = capturing_client(device_id="d1", team_id="t", batch_size=1)
        af.tool(agent_id="a1", tool="python")
        e = batches[0][0]
        self.assertEqual(e["kind"], "tool")
        self.assertEqual(e["tool"], "python")
        self.assertNotIn("phase", e)  # unset optionals stripped by _drop_none
        self.assertNotIn("status", e)

    def test_emit_to_none_is_preserved(self):
        # low-level emit() must not strip an explicit to=None
        af, batches = capturing_client(device_id="d1", team_id="t", batch_size=1)
        af.emit({"kind": "message", "agentId": "a", "from": "a", "to": None})
        self.assertIn("to", batches[0][0])
        self.assertIsNone(batches[0][0]["to"])

    def test_message_broadcast_keeps_to_key(self):
        # message(to=None) is a broadcast: the 'to' key must survive _drop_none,
        # otherwise the collector rejects the event (it requires the key to exist).
        af, batches = capturing_client(device_id="d1", team_id="t", batch_size=1)
        af.message(agent_id="a", frm="a", to=None, msg_type="broadcast")
        e = batches[0][0]
        self.assertIn("to", e)
        self.assertIsNone(e["to"])
        self.assertEqual(e["msgType"], "broadcast")


class TestFailureHandling(unittest.TestCase):
    def test_requeue_and_on_error(self):
        errors = []

        def bad_sender(_url, _body):
            raise RuntimeError("collector down")

        af = AgentFlowClient(
            url="x", device_id="d1", batch_size=10, flush_interval=0,
            sender=bad_sender, on_error=errors.append,
        )
        af.message(agent_id="a", frm="a", to="b", team_id="t")
        af.flush()
        self.assertEqual(len(errors), 1)
        self.assertEqual(af.pending, 1)  # preserved for retry

    def test_max_queue_drops_oldest(self):
        af, _ = capturing_client(device_id="d1", batch_size=99999, max_queue=5)
        for i in range(20):
            af.message(agent_id=str(i), frm="a", to="b", team_id="t")
        self.assertEqual(af.pending, 5)

    def test_close_flushes(self):
        af, batches = capturing_client(device_id="d1", batch_size=99)
        af.message(agent_id="a", frm="a", to="b", team_id="t")
        af.close()
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 1)


class TestHelpers(unittest.TestCase):
    def test_drop_none_removes_none_only(self):
        self.assertEqual(_drop_none({"a": 1, "b": None, "c": 0, "d": False}), {"a": 1, "c": 0, "d": False})


if __name__ == "__main__":
    unittest.main(verbosity=2)

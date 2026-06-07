#!/usr/bin/env python3
"""Live tool-use demo — shows an agent that is busy *thinking / using tools*.

Run against a running collector (default http://localhost:3001/ingest):

    python3 clients/python/demo_tool.py
    # or point elsewhere / use a workspace:
    INGEST_URL=http://localhost:3001/ingest SPACE=demo python3 clients/python/demo_tool.py

Then open the web UI (http://localhost:8080), click this run's task in the
**Tasks** panel, and watch the worker node: a purple spinning ring + "⚙ <tool>"
label means it is actively using that tool. The worker fires a tool event every
~1.5s, so the busy state (5s TTL) stays lit the whole time — i.e. "continuously
using tools". A final phase="end" releases it and the ring fades.
"""

from __future__ import annotations

import os
import time

from agentflow_client import AgentFlowClient

URL = os.environ.get("INGEST_URL", "http://localhost:3001/ingest")
SPACE = os.environ.get("SPACE", "demo")

DEVICE = "device-A"
TEAM = "alpha"
LEAD = "lead"
WORKER = "w1"
TASK = "task-tooldemo"

# the sequence of tools the worker "uses" while grinding on the task
TOOLS = ["search", "browser", "python", "sql", "retrieve", "vector-db", "python"]


def main() -> None:
    af = AgentFlowClient(url=URL, space=SPACE, device_id=DEVICE, team_id=TEAM, flush_interval=0.2)

    # 1) roster appears first
    af.online(agent_id=LEAD, role="comm")
    af.online(agent_id=WORKER, role="worker")

    full = lambda a: f"{DEVICE}/{TEAM}/{a}"

    # 2) leader assigns the work (gives us a focusable task with a message edge)
    af.message(agent_id=LEAD, frm=full(LEAD), to=full(WORKER),
               msg_type="assign", task_id=TASK, body={"goal": "research & summarize"})
    af.flush()
    print(f"[demo] task '{TASK}' started in space '{SPACE}'. "
          f"Open the UI, focus this task, and watch '{WORKER}' work.")

    # 3) the worker keeps using tools — one every 1.5s keeps the busy ring alive
    for i, tool in enumerate(TOOLS, 1):
        af.tool(agent_id=WORKER, tool=tool, phase="start", task_id=TASK,
                summary=f"step {i}/{len(TOOLS)}")
        af.flush()
        print(f"[demo]   {WORKER} ⚙ using {tool} … ({i}/{len(TOOLS)})")
        time.sleep(1.5)

    # 4) worker reports the result and releases the busy state
    af.tool(agent_id=WORKER, tool=TOOLS[-1], phase="end", status="ok",
            task_id=TASK, summary="done")
    af.message(agent_id=WORKER, frm=full(WORKER), to=full(LEAD),
               msg_type="result", task_id=TASK, body={"ok": True})
    af.close()
    print("[demo] done — the worker's ring should fade out shortly.")


if __name__ == "__main__":
    main()

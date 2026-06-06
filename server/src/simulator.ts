// Dev-only traffic generator modeling a concrete hierarchy:
//
//   device-A
//     ├─ team alpha (4): lead(comm) + w1,w2,w3        ← lead is also device-A's comm agent
//     └─ team beta  (4): lead(leader) + w1,w2,w3
//   device-B
//     └─ team gamma (2): lead(comm) + w1
//
// Rules represented:
//  - Each team has a 통솔자(leader). Workers act THROUGH their leader.
//  - Exactly ONE communication agent per device (role "comm"); only comm agents
//    talk across devices.  Inter-device path: worker → leader → comm → comm → leader → worker.
//
//   INGEST_URL=http://localhost:3001/ingest npm run sim

import { makeEventId } from "./id.js";
import type { FlowEventInput } from "./types.js";

const INGEST_URL = process.env.INGEST_URL ?? "http://localhost:3001/ingest";
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS ?? 350);

type Role = "comm" | "leader" | "worker";
interface Spec {
  device: string;
  team: string;
  agent: string;
  role: Role;
  reportsTo?: string; // full id of the agent this one acts through
}

const devA = "device-A";
const devB = "device-B";
const fid = (d: string, t: string, a: string) => `${d}/${t}/${a}`;

const AGENTS: Spec[] = [
  // device-A / team alpha (4) — alpha lead doubles as device-A's comm agent
  { device: devA, team: "alpha", agent: "lead", role: "comm" },
  { device: devA, team: "alpha", agent: "w1", role: "worker", reportsTo: fid(devA, "alpha", "lead") },
  { device: devA, team: "alpha", agent: "w2", role: "worker", reportsTo: fid(devA, "alpha", "lead") },
  { device: devA, team: "alpha", agent: "w3", role: "worker", reportsTo: fid(devA, "alpha", "lead") },
  // device-A / team beta (2) — beta lead reports up to device-A comm agent
  { device: devA, team: "beta", agent: "lead", role: "leader", reportsTo: fid(devA, "alpha", "lead") },
  { device: devA, team: "beta", agent: "w1", role: "worker", reportsTo: fid(devA, "beta", "lead") },
  // device-B / team gamma (4) — gamma lead is device-B's comm agent
  { device: devB, team: "gamma", agent: "lead", role: "comm" },
  { device: devB, team: "gamma", agent: "w1", role: "worker", reportsTo: fid(devB, "gamma", "lead") },
  { device: devB, team: "gamma", agent: "w2", role: "worker", reportsTo: fid(devB, "gamma", "lead") },
  { device: devB, team: "gamma", agent: "w3", role: "worker", reportsTo: fid(devB, "gamma", "lead") },
];

const byId = new Map(AGENTS.map((s) => [fid(s.device, s.team, s.agent), s]));
const workers = AGENTS.filter((s) => s.role === "worker");
const comms = AGENTS.filter((s) => s.role === "comm");

const tasks = ["analyze logs", "rank items", "fetch url", "summarize", "score batch"];
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
const rnd = (n: number) => Math.floor(Math.random() * n);

function message(from: Spec, to: string, msgType: string, body: unknown, taskId: string): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    deviceId: from.device,
    teamId: from.team,
    agentId: from.agent,
    from: fid(from.device, from.team, from.agent),
    to,
    kind: "message",
    op: "send",
    msgType,
    taskId,
    tool: pick(["dispatch", "exec", "route", "fetch"]),
    size: rnd(2048),
    body,
  };
}

function bbWrite(by: Spec, key: string, value: unknown, taskId: string): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    deviceId: by.device,
    teamId: by.team,
    agentId: by.agent,
    kind: "blackboard",
    op: "write",
    key,
    value,
    version: rnd(5),
    taskId,
  };
}

function bbRead(by: Spec, key: string, taskId: string): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    deviceId: by.device,
    teamId: by.team,
    agentId: by.agent,
    kind: "blackboard",
    op: "read",
    key,
    taskId,
  };
}

function agentEvent(s: Spec, status: "online" | "offline"): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    deviceId: s.device,
    teamId: s.team,
    agentId: s.agent,
    kind: "agent",
    status,
    role: s.role,
  };
}

async function post(batch: FlowEventInput[]) {
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
  } catch (err) {
    console.error("[sim] ingest failed:", (err as Error).message);
  }
}

async function registerAll() {
  await post(AGENTS.map((s) => agentEvent(s, "online")));
  console.log(`[sim] registered ${AGENTS.length} agents (device-A: 4+2, device-B: 4, ${comms.length} comm agents)`);
}

// ---- task lifecycle ----
// Each task flows across BOTH devices, correlated by its taskId (the "merge key"):
//   0: device-A worker  -> team leader            (request)
//   1: team leader      -> device-A comm + bb plan(report / write)
//   2: device-A comm    -> device-B comm          (sync — cross-device merge)
//   3: device-B comm    -> device-B worker + bb   (assign / read)
//   4: device-B worker  -> device-B comm + bb     (result / write)  → done
const aComm = byId.get(fid(devA, "alpha", "lead"))!;
const bComm = byId.get(fid(devB, "gamma", "lead"))!;
const aWorkers = workers.filter((w) => w.device === devA);
const bWorkers = workers.filter((w) => w.device === devB);

interface Task {
  id: string;
  step: number;
  aWorker: Spec;
  aLeader: Spec;
  bWorker: Spec;
}
let taskSeq = 0;
const active: Task[] = [];
const MAX_ACTIVE = 6;

function spawnTask(): Task {
  taskSeq++;
  const aWorker = pick(aWorkers);
  return {
    id: `task-${taskSeq.toString(36)}-${rnd(1296).toString(36)}`,
    step: 0,
    aWorker,
    aLeader: byId.get(aWorker.reportsTo!)!,
    bWorker: pick(bWorkers),
  };
}

function advance(task: Task): FlowEventInput[] {
  const t = task.id;
  const a = (s: Spec) => fid(s.device, s.team, s.agent);
  switch (task.step++) {
    case 0:
      return [message(task.aWorker, a(task.aLeader), "request", { task: pick(tasks), n: rnd(100) }, t)];
    case 1:
      return [
        message(task.aLeader, a(aComm), "report", { team: task.aWorker.team, ready: true }, t),
        bbWrite(task.aLeader, `bb:${task.aWorker.team}:plan`, { steps: rnd(5) + 1 }, t),
      ];
    case 2:
      return [message(aComm, a(bComm), "sync", { taskId: t, handoff: true }, t)];
    case 3:
      return [
        message(bComm, a(task.bWorker), "assign", { slot: rnd(8) }, t),
        bbRead(task.bWorker, `bb:${task.aWorker.team}:plan`, t),
      ];
    default:
      return [
        message(task.bWorker, a(bComm), "result", { score: Math.random().toFixed(2) }, t),
        bbWrite(bComm, `bb:result:${t}`, { ok: true }, t),
      ];
  }
}

function tick() {
  const batch: FlowEventInput[] = [];

  // keep a pool of concurrent tasks alive
  if (active.length < MAX_ACTIVE && Math.random() < 0.6) active.push(spawnTask());

  // advance a couple of tasks each tick
  const n = Math.min(active.length, 1 + rnd(2));
  for (let i = 0; i < n; i++) {
    const task = active[rnd(active.length)];
    batch.push(...advance(task));
    if (task.step > 4) active.splice(active.indexOf(task), 1);
  }

  // occasional presence toggle (no taskId)
  if (Math.random() < 0.04) {
    const w = pick(workers);
    batch.push(agentEvent(w, Math.random() < 0.5 ? "offline" : "online"));
  }

  if (batch.length) void post(batch);
}

console.log(`[sim] posting to ${INGEST_URL} every ${INTERVAL_MS}ms`);
void registerAll().then(() => setInterval(tick, INTERVAL_MS));

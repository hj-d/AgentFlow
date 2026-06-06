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
// Pacing — defaults are deliberately slow so the flow is easy to follow by eye.
//   SIM_INTERVAL_MS  how often a step fires (ms)
//   SIM_MAX_ACTIVE   how many tasks run concurrently
//   SIM_SPAWN_PROB   chance per tick of starting a new task (when below MAX_ACTIVE)
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS ?? 1500);
const MAX_ACTIVE = Number(process.env.SIM_MAX_ACTIVE ?? 2);
const SPAWN_PROB = Number(process.env.SIM_SPAWN_PROB ?? 0.25);

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

function message(from: Spec, to: string, msgType: string, body: unknown, taskId: string, space: string): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    space,
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

function bbWrite(by: Spec, key: string, value: unknown, taskId: string, space: string): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    space,
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

function bbRead(by: Spec, key: string, taskId: string, space: string): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    space,
    deviceId: by.device,
    teamId: by.team,
    agentId: by.agent,
    kind: "blackboard",
    op: "read",
    key,
    taskId,
  };
}

function agentEvent(s: Spec, status: "online" | "offline", space: string): FlowEventInput {
  const ts = Date.now();
  return {
    eventId: makeEventId(ts),
    ts,
    space,
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

// Workspaces to simulate (each is fully isolated in the UI). Override with e.g.
//   SPACES=alice,bob npm run sim
const SPACES = (process.env.SPACES ?? "demo").split(",").map((s) => s.trim()).filter(Boolean);

async function registerAll() {
  // register the full agent roster inside every workspace
  for (const space of SPACES) {
    await post(AGENTS.map((s) => agentEvent(s, "online", space)));
  }
  console.log(
    `[sim] registered ${AGENTS.length} agents x ${SPACES.length} workspace(s) [${SPACES.join(", ")}] ` +
      `(device-A: 4+2, device-B: 4, ${comms.length} comm agents)`
  );
}

// ---- task lifecycle ----
// Each task flows across BOTH devices, correlated by its taskId (the "merge key").
// One step fires per tick (mostly a single event) so the whole story unfolds slowly
// and is easy to follow end-to-end:
//   0  device-A worker -> team leader        request
//   1  team leader      bb write             plan
//   2  team leader     -> device-A comm      report (ready)
//   3  device-A comm   -> device-B comm      sync   (cross-device handoff)
//   4  device-B comm    bb read              plan
//   5  device-B comm   -> device-B worker    assign
//   6  device-B worker  bb read              plan   (worker reads the details)
//   7  device-B worker -> device-B comm      progress (50%)
//   8  device-B worker  bb write             partial result
//   9  device-B worker -> device-B comm      result (final)
//  10  device-B comm    bb write             result record
//  11  device-B comm   -> device-A comm      ack    (cross-device, done)
//  12  device-A comm   -> team leader        notify (done)
//  13  team leader     -> device-A worker    deliver (closed)  → done
const LAST_STEP = 13;
const aComm = byId.get(fid(devA, "alpha", "lead"))!;
const bComm = byId.get(fid(devB, "gamma", "lead"))!;
const aWorkers = workers.filter((w) => w.device === devA);
const bWorkers = workers.filter((w) => w.device === devB);

interface Task {
  id: string;
  space: string;
  step: number;
  aWorker: Spec;
  aLeader: Spec;
  bWorker: Spec;
}
let taskSeq = 0;
const active: Task[] = [];

function spawnTask(): Task {
  taskSeq++;
  const aWorker = pick(aWorkers);
  return {
    id: `task-${taskSeq.toString(36)}-${rnd(1296).toString(36)}`,
    space: pick(SPACES), // each task lives in one workspace
    step: 0,
    aWorker,
    aLeader: byId.get(aWorker.reportsTo!)!,
    bWorker: pick(bWorkers),
  };
}

function advance(task: Task): FlowEventInput[] {
  const t = task.id;
  const sp = task.space;
  const a = (s: Spec) => fid(s.device, s.team, s.agent);
  const plan = `bb:${task.aWorker.team}:plan`;
  switch (task.step++) {
    case 0:
      return [message(task.aWorker, a(task.aLeader), "request", { task: pick(tasks), n: rnd(100) }, t, sp)];
    case 1:
      return [bbWrite(task.aLeader, plan, { steps: rnd(5) + 1 }, t, sp)];
    case 2:
      return [message(task.aLeader, a(aComm), "report", { team: task.aWorker.team, ready: true }, t, sp)];
    case 3:
      return [message(aComm, a(bComm), "sync", { taskId: t, handoff: true }, t, sp)];
    case 4:
      return [bbRead(bComm, plan, t, sp)];
    case 5:
      return [message(bComm, a(task.bWorker), "assign", { slot: rnd(8) }, t, sp)];
    case 6:
      return [bbRead(task.bWorker, plan, t, sp)];
    case 7:
      return [message(task.bWorker, a(bComm), "progress", { pct: 50 }, t, sp)];
    case 8:
      return [bbWrite(task.bWorker, `bb:work:${t}`, { partial: true, n: rnd(100) }, t, sp)];
    case 9:
      return [message(task.bWorker, a(bComm), "result", { score: Math.random().toFixed(2) }, t, sp)];
    case 10:
      return [bbWrite(bComm, `bb:result:${t}`, { ok: true }, t, sp)];
    case 11:
      return [message(bComm, a(aComm), "ack", { taskId: t, done: true }, t, sp)];
    case 12:
      return [message(aComm, a(task.aLeader), "notify", { done: true }, t, sp)];
    default:
      return [message(task.aLeader, a(task.aWorker), "deliver", { closed: true }, t, sp)];
  }
}

function tick() {
  const batch: FlowEventInput[] = [];

  // keep a small pool of concurrent tasks alive
  if (active.length < MAX_ACTIVE && Math.random() < SPAWN_PROB) active.push(spawnTask());

  // advance exactly ONE task per tick, so each step is easy to watch
  if (active.length) {
    const task = active[rnd(active.length)];
    batch.push(...advance(task));
    if (task.step > LAST_STEP) active.splice(active.indexOf(task), 1);
  }

  // rare presence toggle (no taskId) in a random workspace
  if (Math.random() < 0.02) {
    const w = pick(workers);
    batch.push(agentEvent(w, Math.random() < 0.5 ? "offline" : "online", pick(SPACES)));
  }

  if (batch.length) void post(batch);
}

console.log(
  `[sim] posting to ${INGEST_URL} every ${INTERVAL_MS}ms ` +
    `(max ${MAX_ACTIVE} concurrent tasks, spawn ${SPAWN_PROB}, ${LAST_STEP + 1} steps/task)`
);
void registerAll().then(() => setInterval(tick, INTERVAL_MS));

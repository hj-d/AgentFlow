import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { AgentNode, EdgeState, PulseFlow } from "../store";
import { BLACKBOARD_ID } from "../types";

// ---- layout constants ----
const AGENT_R = 16;
const AGENT_GAP_X = 78;
const AGENT_GAP_Y = 72;
const AGENTS_PER_ROW = 3;
const TEAM_PAD = 24;
const TEAM_HEADER = 28;
const TEAM_GAP = 30;
const DEVICE_PAD = 26;
const DEVICE_HEADER = 36;
const DEVICE_GAP = 64;
const OUTER = 32;
const INFRA_LANE_H = 100; // reserved band at top for the blackboard
const INFRA_W = 200;
const INFRA_H = 48;

interface Pos {
  x: number;
  y: number;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

interface Layout {
  pos: Record<string, Pos>;
  deviceBoxes: Box[];
  teamBoxes: Box[];
  infra: { id: string; x: number; y: number; w: number; h: number; label: string; icon: string }[];
  width: number;
  height: number;
}

function computeLayout(agents: AgentNode[]): Layout {
  const pos: Record<string, Pos> = {};
  const deviceBoxes: Box[] = [];
  const teamBoxes: Box[] = [];
  const TOP = OUTER + INFRA_LANE_H;

  const byDevice = new Map<string, Map<string, AgentNode[]>>();
  for (const a of agents) {
    if (!byDevice.has(a.deviceId)) byDevice.set(a.deviceId, new Map());
    const teams = byDevice.get(a.deviceId)!;
    if (!teams.has(a.teamId)) teams.set(a.teamId, []);
    teams.get(a.teamId)!.push(a);
  }

  let cursorX = OUTER;
  let maxHeight = TOP + 120;

  for (const [deviceId, teams] of [...byDevice.entries()].sort()) {
    const deviceX = cursorX;
    let teamY = TOP + DEVICE_HEADER;
    let deviceInnerWidth = 0;

    for (const [teamId, members] of [...teams.entries()].sort()) {
      // coordinators first (lead before workers), then by name
      const sorted = members.slice().sort((a, b) => {
        const rank = (x: AgentNode) => (x.role === "comm" ? 0 : x.role === "leader" ? 1 : 2);
        return rank(a) - rank(b) || a.agentId.localeCompare(b.agentId);
      });
      const cols = Math.min(AGENTS_PER_ROW, sorted.length);
      const rows = Math.ceil(sorted.length / AGENTS_PER_ROW);
      const teamInnerW = cols * AGENT_GAP_X;
      const teamW = teamInnerW + TEAM_PAD * 2;
      const teamH = TEAM_HEADER + rows * AGENT_GAP_Y + TEAM_PAD;

      const teamX = deviceX + DEVICE_PAD;
      teamBoxes.push({ x: teamX, y: teamY, w: teamW, h: teamH, label: teamId });

      sorted.forEach((a, i) => {
        const r = Math.floor(i / AGENTS_PER_ROW);
        const c = i % AGENTS_PER_ROW;
        pos[a.id] = {
          x: teamX + TEAM_PAD + c * AGENT_GAP_X + AGENT_GAP_X / 2,
          y: teamY + TEAM_HEADER + r * AGENT_GAP_Y + AGENT_GAP_Y / 2,
        };
      });

      deviceInnerWidth = Math.max(deviceInnerWidth, teamW);
      teamY += teamH + TEAM_GAP;
    }

    const deviceW = deviceInnerWidth + DEVICE_PAD * 2;
    const deviceH = teamY - TOP + DEVICE_PAD - TEAM_GAP;
    deviceBoxes.push({ x: deviceX, y: TOP, w: deviceW, h: deviceH, label: deviceId });

    cursorX = deviceX + deviceW + DEVICE_GAP;
    maxHeight = Math.max(maxHeight, TOP + deviceH + OUTER);
  }

  const width = Math.max(cursorX + OUTER, INFRA_W + OUTER * 2);

  const infraY = OUTER + (INFRA_LANE_H - INFRA_H) / 2;
  const bbX = width * 0.5 - INFRA_W / 2;
  const infra = [{ id: BLACKBOARD_ID, x: bbX, y: infraY, w: INFRA_W, h: INFRA_H, label: "Blackboard", icon: "▤" }];
  for (const n of infra) pos[n.id] = { x: n.x + n.w / 2, y: n.y + n.h / 2 };

  return { pos, deviceBoxes, teamBoxes, infra, width, height: maxHeight };
}

function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 60%)`;
}

const FLOW_CLASS: Record<PulseFlow, string> = {
  message: "msg",
  "bb-write": "bbw",
  "bb-read": "bbr",
};

function preview(data: unknown): string {
  if (data === undefined || data === null) return "";
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return s.length > 30 ? s.slice(0, 29) + "…" : s;
}
function full(data: unknown): string {
  if (data === undefined) return "(no payload)";
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}
function edgeLabel(e: EdgeState): string {
  const p = preview(e.data);
  if (e.label && p) return `${e.label}: ${p}`;
  return e.label ?? p;
}

// Quadratic curve between two nodes; bidirectional edges bow to opposite sides
// (sign by id ordering) so request/response don't overlap.
function curveGeom(a: Pos, b: Pos, fromId: string, toId: string) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const sign = fromId < toId ? 1 : -1;
  const off = Math.min(42, len * 0.16) * sign;
  const cx = (a.x + b.x) / 2 + nx * off;
  const cy = (a.y + b.y) / 2 + ny * off;
  return {
    path: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`,
    labelX: (a.x + 2 * cx + b.x) / 4,
    labelY: (a.y + 2 * cy + b.y) / 4,
    at: (t: number) => {
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
    },
  };
}

const EDGE_TTL = 6000;
const LABEL_TTL = 2000; // only label edges that fired recently — keeps the canvas readable
const PULSE_DUR = 1000;

export function Topology() {
  const agents = useStore((s) => s.agents);
  const pulses = useStore((s) => s.pulses);
  const edges = useStore((s) => s.edges);
  const showEdgeData = useStore((s) => s.showEdgeData);
  const expirePulses = useStore((s) => s.expirePulses);
  const expireEdges = useStore((s) => s.expireEdges);
  const [, force] = useState(0);
  const raf = useRef<number>(0);

  useEffect(() => {
    const loop = () => {
      expirePulses(performance.now());
      expireEdges(Date.now());
      force((n) => (n + 1) % 1_000_000);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [expirePulses, expireEdges]);

  const agentList = useMemo(() => Object.values(agents), [agents]);
  const layout = useMemo(() => computeLayout(agentList), [agentList]);
  const edgeList = useMemo(() => Object.values(edges), [edges]);

  const now = performance.now();
  const wall = Date.now();
  const recentlyActive = new Set<string>();
  for (const a of agentList) if (a.status === "online" && wall - a.lastSeen < 1200) recentlyActive.add(a.id);
  const bbActive = edgeList.some((e) => e.flow !== "message" && wall - e.ts < 900);

  if (agentList.length === 0) {
    return <div className="empty">에이전트 등록을 기다리는 중… (시뮬레이터: <code>npm run sim</code>)</div>;
  }

  const freshLabels = showEdgeData ? edgeList.filter((e) => wall - e.ts < LABEL_TTL) : [];

  return (
    <div className="topology-scroll">
      <svg width={layout.width} height={Math.max(layout.height, 320)} className="topology-svg">
        {/* device + team containers */}
        {layout.deviceBoxes.map((b) => (
          <g key={"dev-" + b.label}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={14} className="device-box" />
            <text x={b.x + 14} y={b.y + 23} className="device-label">
              🖥 {b.label}
            </text>
          </g>
        ))}
        {layout.teamBoxes.map((b, i) => (
          <g key={"team-" + i}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} className="team-box" />
            <text x={b.x + 10} y={b.y + 18} className="team-label">
              {b.label}
            </text>
          </g>
        ))}

        {/* persistent edge curves (faint structure) */}
        {edgeList.map((e) => {
          const a = layout.pos[e.from];
          const b = layout.pos[e.to];
          if (!a || !b) return null;
          const fresh = Math.max(0, 1 - (wall - e.ts) / EDGE_TTL);
          const g = curveGeom(a, b, e.from, e.to);
          return (
            <path
              key={e.id}
              d={g.path}
              fill="none"
              className={"edge " + FLOW_CLASS[e.flow]}
              style={{ opacity: 0.08 + fresh * 0.45 }}
            >
              <title>{`${e.from} → ${e.to}\n[${e.flow}] ${e.label ?? ""}  ×${e.count}\n${full(e.data)}`}</title>
            </path>
          );
        })}

        {/* blackboard node */}
        {layout.infra.map((n) => (
          <g key={n.id}>
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={10}
              className={"infra-box bb" + (bbActive ? " active" : "")}
            />
            <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 5} textAnchor="middle" className="infra-label">
              {n.icon} {n.label}
            </text>
          </g>
        ))}

        {/* agents (coordinators drawn larger with a ring + glyph) */}
        {agentList.map((a) => {
          const p = layout.pos[a.id];
          if (!p) return null;
          const active = recentlyActive.has(a.id);
          const offline = a.status === "offline";
          const isComm = a.role === "comm";
          const isLeader = a.role === "leader";
          const isCoord = isComm || isLeader;
          const r = isComm ? 22 : isLeader ? 20 : AGENT_R;
          return (
            <g key={a.id} transform={`translate(${p.x},${p.y})`} opacity={offline ? 0.4 : 1}>
              <title>{`${a.id}\nrole: ${a.role ?? "agent"} — ${a.status}`}</title>
              {isCoord && <circle r={r + 4} className={"agent-ring " + a.role} fill="none" />}
              <circle
                r={r}
                className={"agent" + (active ? " active" : "") + (offline ? " offline" : "")}
                style={{ fill: offline ? "#3a4150" : colorFor(a.teamId) }}
              />
              {isCoord && (
                <text textAnchor="middle" y={5} className="agent-glyph">
                  {isComm ? "✦" : "★"}
                </text>
              )}
              <text y={r + 13} textAnchor="middle" className="agent-label">
                {a.agentId}
              </text>
              {isCoord && (
                <text y={r + 24} textAnchor="middle" className={"agent-role " + a.role}>
                  {isComm ? "comm" : "leader"}
                </text>
              )}
            </g>
          );
        })}

        {/* moving pulses (on top of nodes) */}
        {pulses.map((p) => {
          const a = layout.pos[p.from];
          const b = layout.pos[p.to];
          if (!a || !b) return null;
          const t = Math.min(1, (now - p.start) / PULSE_DUR);
          const pt = curveGeom(a, b, p.from, p.to).at(t);
          return <circle key={p.id} cx={pt.x} cy={pt.y} r={5} className={"pulse " + FLOW_CLASS[p.flow]} style={{ opacity: 1 - t }} />;
        })}

        {/* fresh data labels — top layer so they're never hidden by nodes */}
        {freshLabels.map((e) => {
          const a = layout.pos[e.from];
          const b = layout.pos[e.to];
          if (!a || !b) return null;
          const fresh = Math.max(0, 1 - (wall - e.ts) / LABEL_TTL);
          const g = curveGeom(a, b, e.from, e.to);
          const text = edgeLabel(e);
          if (!text) return null;
          const w = Math.max(18, text.length * 6.1 + 12);
          return (
            <g key={"lbl-" + e.id} transform={`translate(${g.labelX},${g.labelY})`} style={{ opacity: 0.55 + fresh * 0.45 }}>
              <rect x={-w / 2} y={-9} width={w} height={18} rx={4} className="edge-label-bg" />
              <text textAnchor="middle" y={4} className={"edge-label " + FLOW_CLASS[e.flow]}>
                {text}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

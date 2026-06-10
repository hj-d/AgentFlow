import { useEffect, useRef, useState, useMemo } from "react";
import {
  useStore, ACTIVITY_TTL_MS, EDGE_TTL_MS, THINKING_TTL_MS,
  type EdgeState,
} from "../store";
import type { FlowEvent } from "../types";

// ─── Agent spec ─────────────────────────────────────────────────
const AGENTS = [
  { id: "pc",  icon: "💻", name: "PC",  role: "Creator",      cls: "pc"  as const },
  { id: "hub", icon: "🏠", name: "Hub", role: "Orchestrator", cls: "hub" as const },
  { id: "tv",  icon: "📺", name: "TV",  role: "Display",      cls: "tv"  as const },
];

// ─── Colors ─────────────────────────────────────────────────────
const FLOW_COLOR: Record<string, string> = {
  delegate:   "#6366f1",
  noti:       "#0ea5e9",
  "bb-write": "#f59e0b",
  "bb-read":  "#10b981",
};
const FLOW_BG: Record<string, string> = {
  delegate:   "#eef2ff",
  noti:       "#f0f9ff",
  "bb-write": "#fffbeb",
  "bb-read":  "#f0fdf4",
};

// ─── Helpers ────────────────────────────────────────────────────
function snip(v: unknown, max = 22): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ─── Activity items ─────────────────────────────────────────────
interface ActivityItem {
  id: string;
  ts: number;
  type: "tool" | "delegate" | "bb" | "noti";
  icon: string;
  brief: string;
  detail?: unknown;
}

function getAgentActivities(
  events: FlowEvent[], agentId: string, taskId?: string,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const e of events) {
    if (taskId && e.taskId && e.taskId !== taskId) continue;

    if (e.kind === "tool" && e.agentId === agentId && e.phase === "end") {
      items.push({
        id: e.eventId,
        ts: e.ts,
        type: "tool",
        icon: e.status === "error" ? "✗" : "⚙",
        brief: `${e.tool}${e.output != null ? " → " + snip(e.output, 22) : ""}`,
        detail: { tool: e.tool, input: e.input, output: e.output, status: e.status },
      });
    } else if (e.kind === "delegate" && e.from === agentId && e.phase === "dispatch") {
      items.push({
        id: e.eventId,
        ts: e.ts,
        type: "delegate",
        icon: "→",
        brief: `${e.to}: ${snip(e.task, 22) || "위임"}`,
        detail: e.payload,
      });
    } else if (e.kind === "delegate" && e.to === agentId && e.phase === "return") {
      items.push({
        id: e.eventId,
        ts: e.ts,
        type: "delegate",
        icon: "↩",
        brief: `${e.from} 완료`,
        detail: e.payload,
      });
    } else if (e.kind === "blackboard" && e.agentId === agentId) {
      items.push({
        id: e.eventId,
        ts: e.ts,
        type: "bb",
        icon: e.op === "write" ? "✍" : "📖",
        brief: `${e.key}${e.op === "write" ? ": " + snip(e.value, 18) : ""}`,
        detail: e.op === "write" ? e.value : null,
      });
    } else if (e.kind === "noti" && e.agentId === agentId) {
      const targets = Array.isArray(e.to) ? e.to.join(", ") : String(e.to ?? "");
      items.push({
        id: e.eventId,
        ts: e.ts,
        type: "noti",
        icon: e.phase === "broadcast" ? "📢" : "✓",
        brief: e.phase === "broadcast"
          ? `${targets}${e.key ? " · " + e.key : ""}`
          : `확인`,
        detail: e.message ?? null,
      });
    }
  }

  return items.sort((a, b) => b.ts - a.ts).slice(0, 8);
}

// ─── ThinkDots ──────────────────────────────────────────────────
function ThinkDots({ size = "sm" }: { size?: "sm" | "xs" }) {
  return (
    <span className={`think-dots think-${size}`}>
      <span /><span /><span />
    </span>
  );
}

// ─── ActivityStack ──────────────────────────────────────────────
function ActivityStack({ items }: { items: ActivityItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (items.length === 0) return null;

  return (
    <div className="act-stack">
      {items.map((item) => {
        const isOpen = openId === item.id;
        const hasDetail = item.detail != null;
        return (
          <div
            key={item.id}
            className={`act-item act-${item.type}${isOpen ? " open" : ""}${hasDetail ? " clickable" : ""}`}
            onClick={() => hasDetail && setOpenId(isOpen ? null : item.id)}
          >
            <div className="act-item-row">
              <span className="act-icon">{item.icon}</span>
              <span className="act-brief">{item.brief}</span>
              {hasDetail && (
                <span className="act-caret">{isOpen ? "▾" : "▸"}</span>
              )}
            </div>
            {isOpen && hasDetail && (
              <pre className="act-detail">
                {typeof item.detail === "string"
                  ? item.detail
                  : JSON.stringify(item.detail, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── UserNode ───────────────────────────────────────────────────
function UserNode({ request, done }: { request: string; done: boolean }) {
  return (
    <div className={`user-node${done ? " done" : ""}`}>
      <div className="user-node-left">
        <div className="user-node-avatar">👤</div>
        <div className="user-node-connector" />
      </div>
      <div className="user-node-body">
        <span className="user-node-label">사용자 요청</span>
        <span className="user-node-req">{request}</span>
        {done && <span className="user-node-done">✅ 완료</span>}
      </div>
    </div>
  );
}

// ─── AgentCard ──────────────────────────────────────────────────
interface AgentCardProps {
  spec: typeof AGENTS[number];
  online: boolean;
  thinking: boolean;
  busy: boolean;
  toolName?: string;
}

function AgentCard({ spec, online, thinking, busy, toolName }: AgentCardProps) {
  let statusText = "대기 중";
  let statusCls = "idle";
  if (!online)           { statusText = "오프라인";          statusCls = "offline"; }
  else if (busy && toolName) { statusText = toolName;        statusCls = "busy"; }
  else if (busy)         { statusText = "작업 중";           statusCls = "busy"; }
  else if (thinking)     { statusText = "추론 중…";          statusCls = "thinking"; }

  const isHub = spec.id === "hub";

  return (
    <div className={`ag-card ${spec.cls} ${statusCls}`}>
      <div className="ag-card-top">
        <div className="ag-icon-wrap">
          <span className="ag-icon">{spec.icon}</span>
          <span className={`ag-dot ${statusCls}`} />
        </div>
        <div className="ag-info">
          <div className="ag-name-row">
            <span className="ag-name">{spec.name}</span>
            {isHub
              ? <span className="ag-orch">Orchestrator</span>
              : <span className={`ag-role ${spec.cls}`}>{spec.role}</span>}
          </div>
          <div className={`ag-status ${statusCls}`}>
            {statusCls === "busy"     && <span className="ag-spin">⚙</span>}
            {statusCls === "thinking" && <ThinkDots size="xs" />}
            <span className="ag-status-text">{statusText}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── BBNode ─────────────────────────────────────────────────────
function BBNode({
  blackboard, edgeList,
}: {
  blackboard: Record<string, { value: unknown; by: string; ts: number; reads: number }>;
  edgeList: EdgeState[];
}) {
  const entries = Object.entries(blackboard).sort((a, b) => b[1].ts - a[1].ts);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const wall = Date.now();

  function getOp(key: string): "write" | "read" | null {
    for (const e of edgeList) {
      if (e.label === key && wall - e.ts < 2500) {
        if (e.flow === "bb-write") return "write";
        if (e.flow === "bb-read")  return "read";
      }
    }
    return null;
  }

  if (entries.length === 0) return null;

  return (
    <div className="bb-node">
      <div className="bb-node-head">
        <span className="bb-node-icon">🗄️</span>
        <span className="bb-node-title">Blackboard</span>
        <span className="bb-node-count">{entries.length}개 키</span>
      </div>
      <div className="bb-node-rows">
        {entries.map(([key, entry]) => {
          const op = getOp(key);
          const isOpen = openKey === key;
          return (
            <div
              key={key}
              className={`bb-node-row ${op ?? ""}${isOpen ? " open" : ""}`}
              onClick={() => setOpenKey(isOpen ? null : key)}
            >
              <span className={`bb-node-op ${op ?? "idle"}`}>
                {op === "write" ? "W" : op === "read" ? "R" : "·"}
              </span>
              <span className="bb-node-key">{key}</span>
              <span className="bb-node-val">{snip(entry.value, 28)}</span>
              <span className={`bb-node-by bb-by-${entry.by}`}>{entry.by}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SVG Line + Label ────────────────────────────────────────────
interface Pt { x: number; y: number }
interface CardPos { x: number; y: number; w: number; h: number }

function cardPt(p: CardPos, side: "top" | "bottom" | "left" | "right" | "center"): Pt {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  switch (side) {
    case "top":    return { x: cx, y: p.y };
    case "bottom": return { x: cx, y: p.y + p.h };
    case "left":   return { x: p.x, y: cy };
    case "right":  return { x: p.x + p.w, y: cy };
    case "center": return { x: cx, y: cy };
  }
}

function edgeLabelText(edge: EdgeState): string {
  const label = snip(edge.label, 20);
  switch (edge.flow) {
    case "delegate": return edge.from === "hub" ? `→ ${label || "위임"}` : `↩ ${label || "반환"}`;
    case "noti":     return `📢 ${label || "알림"}`;
    case "bb-write": return `✍ ${label}`;
    case "bb-read":  return `📖 ${label}`;
    default:         return label;
  }
}

function SvgEdge({
  from, to, edge, wall, alwaysShow,
}: {
  from: Pt; to: Pt;
  edge: EdgeState | null; wall: number;
  alwaysShow?: boolean;
}) {
  const age   = edge ? wall - edge.ts : EDGE_TTL_MS + 1;
  const active = age < EDGE_TTL_MS;
  const fresh  = active ? Math.max(0, 1 - age / EDGE_TTL_MS) : 0;

  if (!alwaysShow && !active) return null;

  const color    = active ? (FLOW_COLOR[edge!.flow] ?? "#6366f1") : "#94a3b8";
  const lineOp   = active ? 0.55 + fresh * 0.45 : 0.28;
  const strokeW  = active ? 2.5 : 1.5;
  const dash     = active ? undefined : "6 4";

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  const labelText  = active && edge ? edgeLabelText(edge) : null;
  const labelOpacity = active ? 0.6 + fresh * 0.4 : 0;
  const TW = labelText ? Math.max(labelText.length * 6.8 + 18, 52) : 0;
  const TH = 18;
  const bg = active && edge ? (FLOW_BG[edge.flow] ?? "#ffffff") : "#ffffff";

  return (
    <g>
      <line
        x1={from.x} y1={from.y} x2={to.x} y2={to.y}
        stroke={color}
        strokeWidth={strokeW}
        strokeDasharray={dash}
        opacity={lineOp}
        strokeLinecap="round"
      />
      {labelText && (
        <g style={{ opacity: labelOpacity }}>
          <rect
            x={mx - TW / 2} y={my - TH / 2}
            width={TW} height={TH} rx={5}
            fill={bg} stroke={color} strokeWidth="1"
          />
          <text
            x={mx} y={my + 4.5}
            textAnchor="middle"
            fill={color} fontSize="9" fontWeight="600" fontFamily="inherit"
          >{labelText}</text>
        </g>
      )}
    </g>
  );
}

// ─── Main component ──────────────────────────────────────────────
export function DeviceTopology() {
  const agents         = useStore((s) => s.agents);
  const edges          = useStore((s) => s.edges);
  const blackboard     = useStore((s) => s.blackboard);
  const events         = useStore((s) => s.events);
  const taskIO         = useStore((s) => s.taskIO);
  const expireEdges    = useStore((s) => s.expireEdges);
  const expireActivity = useStore((s) => s.expireActivity);
  const [, tick]       = useState(0);

  // Refs for SVG line measurement
  const containerRef = useRef<HTMLDivElement>(null);
  const userRef      = useRef<HTMLDivElement>(null);
  const hubRef       = useRef<HTMLDivElement>(null);
  const pcRef        = useRef<HTMLDivElement>(null);
  const tvRef        = useRef<HTMLDivElement>(null);
  const bbRef        = useRef<HTMLDivElement>(null);

  const [pos, setPos]       = useState<Record<string, CardPos>>({});
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const prevPosRef           = useRef<Record<string, CardPos>>({});

  const taskId = taskIO?.taskId;

  // ─── RAF loop: expire + measure + tick ─────────────────────────
  const rafRef = useRef<number>(0);
  useEffect(() => {
    let lastT = 0;

    const measure = () => {
      const cr = containerRef.current?.getBoundingClientRect();
      if (!cr) return;
      const map: Record<string, React.RefObject<HTMLDivElement | null>> = {
        user: userRef, hub: hubRef, pc: pcRef, tv: tvRef, bb: bbRef,
      };
      const next: Record<string, CardPos> = {};
      for (const [id, ref] of Object.entries(map)) {
        if (!ref.current) continue;
        const r = ref.current.getBoundingClientRect();
        next[id] = { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height };
      }
      const changed =
        Object.keys(next).length !== Object.keys(prevPosRef.current).length ||
        Object.entries(next).some(([id, p]) => {
          const q = prevPosRef.current[id];
          return !q || q.x !== p.x || q.y !== p.y || q.w !== p.w || q.h !== p.h;
        });
      if (changed) { prevPosRef.current = next; setPos(next); }

      const newW = cr.width;
      const newH = containerRef.current?.scrollHeight ?? cr.height;
      setSvgSize(prev => (prev.w === newW && prev.h === newH ? prev : { w: newW, h: newH }));
    };

    const loop = (now: number) => {
      if (now - lastT > 200) {
        lastT = now;
        expireEdges(Date.now());
        expireActivity(Date.now());
        measure();
        tick((n) => (n + 1) % 1_000_000);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [expireEdges, expireActivity]);

  const wall     = Date.now();
  const edgeList = useMemo(() => Object.values(edges), [edges]);
  const hasBB    = Object.keys(blackboard).length > 0;
  const hasAnyAgent = AGENTS.some((a) => !!agents[a.id]);

  // ─── Best edge between two nodes ───────────────────────────────
  function bestEdge(a: string, b: string): EdgeState | null {
    let best: EdgeState | null = null;
    for (const e of edgeList) {
      const hit = (e.from === a && e.to === b) || (e.from === b && e.to === a);
      if (hit && wall - e.ts < EDGE_TTL_MS && (!best || e.ts > best.ts)) best = e;
    }
    return best;
  }

  function bestBBEdge(agentId: string): EdgeState | null {
    let best: EdgeState | null = null;
    for (const e of edgeList) {
      const hit =
        (e.from === agentId && e.to === "__blackboard__") ||
        (e.from === "__blackboard__" && e.to === agentId);
      if (hit && wall - e.ts < EDGE_TTL_MS && (!best || e.ts > best.ts)) best = e;
    }
    return best;
  }

  // ─── Per-agent state ────────────────────────────────────────────
  const agState = useMemo(() => {
    return AGENTS.map((spec) => {
      const agent   = agents[spec.id];
      const online   = agent ? agent.phase === "start" : false;
      const thinking = !!(agent?.thinking && agent.thinkingTs &&
                         wall - agent.thinkingTs < THINKING_TTL_MS);
      const busy     = !!(agent?.activity?.phase === "start" &&
                         wall - (agent.activity?.ts ?? 0) < ACTIVITY_TTL_MS);
      const toolName = agent?.activity?.tool;
      const acts     = getAgentActivities(events, spec.id, taskId);
      return { spec, online, thinking, busy, toolName, acts };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, events, wall, taskId]);

  const [hubState, pcState, tvState] = [agState[1], agState[0], agState[2]];

  // ─── SVG edge data ──────────────────────────────────────────────
  const pcHubEdge = bestEdge("pc", "hub");
  const hubTvEdge = bestEdge("hub", "tv");
  const pcBBEdge  = bestBBEdge("pc");
  const tvBBEdge  = bestBBEdge("tv");
  const hubBBEdge = bestBBEdge("hub");

  // ─── Card positions ─────────────────────────────────────────────
  const userP = pos["user"];
  const hubP  = pos["hub"];
  const pcP   = pos["pc"];
  const tvP   = pos["tv"];
  const bbP   = pos["bb"];

  if (!hasAnyAgent) {
    return (
      <div className="topo-empty-state">
        <div style={{ fontSize: 36, opacity: 0.3 }}>⏳</div>
        <div>시뮬레이터 대기 중…</div>
        <code>npm run sim</code>
      </div>
    );
  }

  return (
    <div className="topo-scroll">
      <div className="topo-container" ref={containerRef}>

        {/* SVG overlay — connection lines */}
        <svg
          style={{
            position: "absolute", top: 0, left: 0,
            width: svgSize.w || "100%", height: svgSize.h || "100%",
            pointerEvents: "none", overflow: "visible", zIndex: 0,
          }}
        >
          {/* User → Hub */}
          {userP && hubP && (
            <SvgEdge
              from={cardPt(userP, "bottom")}
              to={cardPt(hubP, "top")}
              edge={null}
              wall={wall}
              alwaysShow
            />
          )}

          {/* Hub ↔ PC (always visible, colored when active) */}
          {hubP && pcP && (
            <SvgEdge
              from={cardPt(hubP, "bottom")}
              to={cardPt(pcP, "top")}
              edge={pcHubEdge}
              wall={wall}
              alwaysShow
            />
          )}

          {/* Hub ↔ TV (always visible, colored when active) */}
          {hubP && tvP && (
            <SvgEdge
              from={cardPt(hubP, "bottom")}
              to={cardPt(tvP, "top")}
              edge={hubTvEdge}
              wall={wall}
              alwaysShow
            />
          )}

          {/* PC → BB (show when BB has data) */}
          {pcP && bbP && hasBB && (
            <SvgEdge
              from={cardPt(pcP, "bottom")}
              to={{ x: bbP.x + bbP.w * 0.25, y: bbP.y }}
              edge={pcBBEdge}
              wall={wall}
              alwaysShow
            />
          )}

          {/* TV → BB */}
          {tvP && bbP && hasBB && (
            <SvgEdge
              from={cardPt(tvP, "bottom")}
              to={{ x: bbP.x + bbP.w * 0.75, y: bbP.y }}
              edge={tvBBEdge}
              wall={wall}
              alwaysShow
            />
          )}

          {/* Hub → BB */}
          {hubP && bbP && hasBB && (
            <SvgEdge
              from={cardPt(hubP, "bottom")}
              to={cardPt(bbP, "top")}
              edge={hubBBEdge}
              wall={wall}
              alwaysShow
            />
          )}
        </svg>

        {/* ── User request node ── */}
        {taskIO?.request && (
          <div className="topo-user-row">
            <div ref={userRef}>
              <UserNode request={taskIO.request} done={taskIO.result != null} />
            </div>
          </div>
        )}

        {/* ── Hub row ── */}
        <div className="topo-hub-row">
          <ActivityStack items={hubState.acts} />
          <div ref={hubRef} style={{ zIndex: 1 }}>
            <AgentCard {...hubState} />
          </div>
        </div>

        {/* ── Worker row ── */}
        <div className="topo-worker-row">
          {/* PC: activity stack LEFT, card RIGHT */}
          <div className="topo-agent-block pc">
            <ActivityStack items={pcState.acts} />
            <div ref={pcRef} style={{ zIndex: 1 }}>
              <AgentCard {...pcState} />
            </div>
          </div>

          {/* TV: card LEFT, activity stack RIGHT */}
          <div className="topo-agent-block tv">
            <div ref={tvRef} style={{ zIndex: 1 }}>
              <AgentCard {...tvState} />
            </div>
            <ActivityStack items={tvState.acts} />
          </div>
        </div>

        {/* ── Blackboard ── */}
        {hasBB && (
          <div className="topo-bb-row">
            <div ref={bbRef} style={{ width: "100%", maxWidth: 520, zIndex: 1 }}>
              <BBNode blackboard={blackboard} edgeList={edgeList} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

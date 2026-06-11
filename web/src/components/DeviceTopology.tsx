import { useEffect, useRef, useState, useMemo } from "react";
import {
  useStore, ACTIVITY_TTL_MS, EDGE_TTL_MS, THINKING_TTL_MS, USER_ID,
  type EdgeState, type Pulse, type AgentNode,
} from "../store";
import { BLACKBOARD_ID, type FlowEvent } from "../types";
import { getAgentMeta, type AgentMeta } from "../lib/agentMeta";

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

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// CJK-aware width estimate for SVG label chips
function textWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x1100 ? fontSize : fontSize * 0.62;
  return w;
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
        brief: `${e.tool}${e.output != null ? " → " + snip(e.output, 24) : ""}`,
        detail: { tool: e.tool, input: e.input, output: e.output, status: e.status },
      });
    } else if (e.kind === "delegate" && e.from === agentId && e.phase === "dispatch") {
      items.push({
        id: e.eventId,
        ts: e.ts,
        type: "delegate",
        icon: "→",
        brief: `${e.to}: ${snip(e.task, 24) || "위임"}`,
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
// 클릭 시 상세 토글 + 우측 이벤트 패널과 상호 하이라이트(linkedEventId).
function ActivityStack({ items }: { items: ActivityItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const linkedEventId = useStore((s) => s.linkedEventId);
  const setLinkedEventId = useStore((s) => s.setLinkedEventId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!linkedEventId || !ref.current) return;
    const el = ref.current.querySelector(`[data-evid="${CSS.escape(linkedEventId)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [linkedEventId]);

  if (items.length === 0) return null;

  return (
    <div className="act-stack" ref={ref}>
      {items.map((item) => {
        const isOpen = openId === item.id;
        const linked = linkedEventId === item.id;
        const hasDetail = item.detail != null;
        return (
          <div
            key={item.id}
            data-evid={item.id}
            className={`act-item act-${item.type}${isOpen ? " open" : ""}${hasDetail ? " clickable" : ""}${linked ? " linked" : ""}`}
            onClick={() => {
              if (hasDetail) setOpenId(isOpen ? null : item.id);
              setLinkedEventId(item.id);
            }}
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
  meta: AgentMeta;
  online: boolean;
  thinking: boolean;
  busy: boolean;
  toolName?: string;
}

function AgentCard({ meta, online, thinking, busy, toolName }: AgentCardProps) {
  let statusText = "대기 중";
  let statusCls = "idle";
  if (!online)               { statusText = "오프라인";   statusCls = "offline"; }
  else if (busy && toolName) { statusText = toolName;     statusCls = "busy"; }
  else if (busy)             { statusText = "작업 중";    statusCls = "busy"; }
  else if (thinking)         { statusText = "추론 중…";   statusCls = "thinking"; }

  const isHub = meta.type === "hub";

  return (
    <div className={`ag-card ${meta.cls} ${statusCls}`}>
      <div className="ag-card-top">
        <div className="ag-icon-wrap">
          <span className="ag-icon">{meta.icon}</span>
          <span className={`ag-dot ${statusCls}`} />
        </div>
        <div className="ag-info">
          <div className="ag-name-row">
            <span className="ag-name">{meta.name}</span>
            {isHub
              ? <span className="ag-orch">Orchestrator</span>
              : <span className={`ag-role ${meta.cls}`}>{meta.role}</span>}
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
  blackboard, edgeList, agents,
}: {
  blackboard: Record<string, { value: unknown; by: string; ts: number; reads: number }>;
  edgeList: EdgeState[];
  agents: Record<string, AgentNode>;
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
          const byMeta = getAgentMeta(entry.by, agents[entry.by]);
          return (
            <div key={key} className="bb-node-entry">
              <div
                className={`bb-node-row ${op ?? ""}${isOpen ? " open" : ""}`}
                onClick={() => setOpenKey(isOpen ? null : key)}
                title="클릭하면 상세 보기"
              >
                <span className={`bb-node-op ${op ?? "idle"}`}>
                  {op === "write" ? "W" : op === "read" ? "R" : "·"}
                </span>
                <span className="bb-node-key">{key}</span>
                <span className="bb-node-val">{snip(entry.value, 28)}</span>
                <span className={`bb-node-by bb-by-${byMeta.type}`}>{entry.by}</span>
                <span className="bb-node-caret">{isOpen ? "▾" : "▸"}</span>
              </div>
              {isOpen && (
                <div className="bb-node-detail">
                  <div className="bb-detail-meta">
                    <span>✍ {byMeta.icon} {byMeta.name}</span>
                    <span>🕐 {fmtClock(entry.ts)}</span>
                    <span>📖 {entry.reads}회 읽음</span>
                  </div>
                  <pre className="bb-detail-json">
                    {entry.value === undefined
                      ? "—"
                      : typeof entry.value === "string"
                        ? entry.value
                        : JSON.stringify(entry.value, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SVG geometry ────────────────────────────────────────────────
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
    case "delegate":
      if (edge.from === USER_ID) return `📨 ${label}`;
      if (edge.to === USER_ID)   return `✅ ${label}`;
      return edge.label === "return" ? "↩ 반환" : `→ ${label || "위임"}`;
    case "noti":     return `📢 ${label || "알림"}`;
    case "bb-write": return `✍ ${label}`;
    case "bb-read":  return `📖 ${label}`;
    default:         return label;
  }
}

// ─── SVG Edge (line + static label + direction arrow) ───────────
function SvgEdge({
  from, to, edge, wall, alwaysShow,
}: {
  from: Pt; to: Pt;
  edge: EdgeState | null; wall: number;
  alwaysShow?: boolean;
}) {
  const age    = edge ? wall - edge.ts : EDGE_TTL_MS + 1;
  const active = age < EDGE_TTL_MS;
  const fresh  = active ? Math.max(0, 1 - age / EDGE_TTL_MS) : 0;

  if (!alwaysShow && !active) return null;

  const color    = active ? (FLOW_COLOR[edge!.flow] ?? "#6366f1") : "#94a3b8";
  const lineOp   = active ? 0.55 + fresh * 0.45 : 0.28;
  const strokeW  = active ? 2.5 : 1.5;
  const dash     = active ? undefined : "6 4";

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  const labelText    = active && edge ? edgeLabelText(edge) : null;
  const labelOpacity = active ? 0.6 + fresh * 0.4 : 0;
  const TW = labelText ? Math.max(textWidth(labelText, 10) + 18, 52) : 0;
  const TH = 19;
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
        markerEnd={active && edge ? `url(#ah-${edge.flow})` : undefined}
      />
      {labelText && (
        <g style={{ opacity: labelOpacity }}>
          <rect
            x={mx - TW / 2} y={my - TH / 2}
            width={TW} height={TH} rx={6}
            fill={bg} stroke={color} strokeWidth="1"
          />
          <text
            x={mx} y={my + 3.5}
            textAnchor="middle"
            fill={color} fontSize="10" fontWeight="600" fontFamily="inherit"
          >{labelText}</text>
        </g>
      )}
    </g>
  );
}

// ─── PulseDot — 간선 위를 이동하는 정보 (방향 + 내용) ─────────────
function PulseDot({ pulse, path }: { pulse: Pulse; path: string }) {
  const color = FLOW_COLOR[pulse.flow] ?? "#6366f1";
  const bg    = FLOW_BG[pulse.flow] ?? "#ffffff";
  const label = pulse.label;
  const w = label ? Math.max(textWidth(label, 10) + 16, 40) : 0;

  return (
    <g
      className="pulse-group"
      style={{ offsetPath: `path("${path}")` } as React.CSSProperties}
    >
      <circle className="pulse-halo" r={9} fill="none" stroke={color} strokeWidth={1.5} />
      <circle r={4.5} fill={color} />
      {label && (
        <g>
          <rect x={-w / 2} y={-28} width={w} height={18} rx={9} fill={bg} stroke={color} strokeWidth={1} />
          <text x={0} y={-15} textAnchor="middle" fill={color} fontSize="10" fontWeight="700" fontFamily="inherit">
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

// ─── Main component ──────────────────────────────────────────────
export function DeviceTopology() {
  const agents         = useStore((s) => s.agents);
  const edges          = useStore((s) => s.edges);
  const pulses         = useStore((s) => s.pulses);
  const blackboard     = useStore((s) => s.blackboard);
  const events         = useStore((s) => s.events);
  const taskIO         = useStore((s) => s.taskIO);
  const expireEdges    = useStore((s) => s.expireEdges);
  const expireActivity = useStore((s) => s.expireActivity);
  const expirePulses   = useStore((s) => s.expirePulses);
  const [, tick]       = useState(0);

  // Node DOM measurement — dynamic node set, keyed by node id
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs     = useRef<Record<string, HTMLDivElement | null>>({});
  const refCbs       = useRef<Record<string, (el: HTMLDivElement | null) => void>>({});
  const setNodeRef = (id: string) =>
    (refCbs.current[id] ??= (el) => { nodeRefs.current[id] = el; });

  const [pos, setPos]         = useState<Record<string, CardPos>>({});
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const prevPosRef            = useRef<Record<string, CardPos>>({});

  const taskId = taskIO?.taskId;

  // ─── RAF loop: expire + measure + tick ─────────────────────────
  const rafRef = useRef<number>(0);
  useEffect(() => {
    let lastT = 0;

    const measure = () => {
      const cr = containerRef.current?.getBoundingClientRect();
      if (!cr) return;
      const next: Record<string, CardPos> = {};
      for (const [id, el] of Object.entries(nodeRefs.current)) {
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
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
        expirePulses(performance.now());
        measure();
        tick((n) => (n + 1) % 1_000_000);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [expireEdges, expireActivity, expirePulses]);

  const wall     = Date.now();
  const edgeList = useMemo(() => Object.values(edges), [edges]);
  const hasBB    = Object.keys(blackboard).length > 0;

  // ─── Dynamic agent set — 호출된 에이전트만 노드로 생성 ───────────
  const agentList = Object.values(agents);
  const hubAgent = agentList
    .filter((a) => getAgentMeta(a.id, a).type === "hub")
    .sort((a, b) => a.firstSeen - b.firstSeen)[0];
  const workers = agentList
    .filter((a) => a !== hubAgent)
    .sort((a, b) => (a.firstSeen - b.firstSeen) || a.id.localeCompare(b.id));

  const workerIndex: Record<string, number> = {};
  workers.forEach((w, i) => { workerIndex[w.id] = i; });

  // ─── Geometry resolution (generic, N agents) ───────────────────
  const vid = (id: string) => id === BLACKBOARD_ID ? "bb" : id === USER_ID ? "user" : id;

  function rankOf(id: string): number {
    if (id === "user") return 0;
    if (id === "bb") return 3;
    if (hubAgent && id === hubAgent.id) return 1;
    return 2;
  }

  function bbAnchorX(otherId: string): number {
    const bbP = pos["bb"];
    if (!bbP) return 0;
    const idx = workerIndex[otherId];
    if (idx === undefined || workers.length === 0) return bbP.x + bbP.w / 2;
    return bbP.x + bbP.w * ((idx + 1) / (workers.length + 1));
  }

  function anchorBetween(srcId: string, dstId: string): { from: Pt; to: Pt } | null {
    const a = pos[srcId], b = pos[dstId];
    if (!a || !b) return null;
    const ra = rankOf(srcId), rb = rankOf(dstId);
    if (ra === rb) {
      // same row (worker ↔ worker): connect facing sides
      const leftFirst = a.x + a.w / 2 <= b.x + b.w / 2;
      return { from: cardPt(a, leftFirst ? "right" : "left"), to: cardPt(b, leftFirst ? "left" : "right") };
    }
    const down = ra < rb;
    let from = cardPt(a, down ? "bottom" : "top");
    let to   = cardPt(b, down ? "top" : "bottom");
    if (srcId === "bb") from = { x: bbAnchorX(dstId), y: a.y };
    if (dstId === "bb") to   = { x: bbAnchorX(srcId), y: b.y };
    return { from, to };
  }

  function bestEdge(aRaw: string, bRaw: string): EdgeState | null {
    let best: EdgeState | null = null;
    for (const e of edgeList) {
      const hit = (e.from === aRaw && e.to === bRaw) || (e.from === bRaw && e.to === aRaw);
      if (hit && wall - e.ts < EDGE_TTL_MS && (!best || e.ts > best.ts)) best = e;
    }
    return best;
  }

  // Render one edge; orient line by edge direction when active.
  function renderEdge(aId: string, bId: string, edge: EdgeState | null, alwaysShow: boolean, key: string) {
    const active = edge && wall - edge.ts < EDGE_TTL_MS;
    const pts = active
      ? anchorBetween(vid(edge!.from), vid(edge!.to)) ?? anchorBetween(aId, bId)
      : anchorBetween(aId, bId);
    if (!pts) return null;
    return <SvgEdge key={key} from={pts.from} to={pts.to} edge={edge} wall={wall} alwaysShow={alwaysShow} />;
  }

  // ─── Per-agent visual state ─────────────────────────────────────
  function visual(a: AgentNode) {
    const online   = a.phase === "start";
    const thinking = !!(a.thinking && a.thinkingTs && wall - a.thinkingTs < THINKING_TTL_MS);
    const busy     = !!(a.activity?.phase === "start" && wall - (a.activity?.ts ?? 0) < ACTIVITY_TTL_MS);
    return {
      meta: getAgentMeta(a.id, a),
      online, thinking, busy,
      toolName: a.activity?.tool,
      acts: getAgentActivities(events, a.id, taskId),
    };
  }

  if (agentList.length === 0) {
    return (
      <div className="topo-empty-state">
        <div style={{ fontSize: 36, opacity: 0.3 }}>⏳</div>
        <div>시뮬레이터 대기 중…</div>
        <code>npm run sim</code>
      </div>
    );
  }

  const hubV = hubAgent ? visual(hubAgent) : null;

  // ─── Structural edges + extra active edges ─────────────────────
  const structuralPairs = new Set<string>();
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");

  const structuralEdges: (React.ReactNode | null)[] = [];
  if (hubAgent) {
    structuralPairs.add(pairKey("user", hubAgent.id));
    structuralEdges.push(renderEdge("user", hubAgent.id, bestEdge(USER_ID, hubAgent.id), true, "user-hub"));
    for (const w of workers) {
      structuralPairs.add(pairKey(hubAgent.id, w.id));
      structuralEdges.push(renderEdge(hubAgent.id, w.id, bestEdge(hubAgent.id, w.id), true, `hub-${w.id}`));
    }
    if (hasBB) {
      structuralPairs.add(pairKey(hubAgent.id, "bb"));
      structuralEdges.push(renderEdge(hubAgent.id, "bb", bestEdge(hubAgent.id, BLACKBOARD_ID), true, "hub-bb"));
    }
  }
  if (hasBB) {
    for (const w of workers) {
      structuralPairs.add(pairKey(w.id, "bb"));
      structuralEdges.push(renderEdge(w.id, "bb", bestEdge(w.id, BLACKBOARD_ID), true, `${w.id}-bb`));
    }
  }

  // Active edges not covered by the structure (e.g. worker ↔ worker)
  const extraByPair = new Map<string, EdgeState>();
  for (const e of edgeList) {
    if (wall - e.ts >= EDGE_TTL_MS) continue;
    const a = vid(e.from), b = vid(e.to);
    const k = pairKey(a, b);
    if (structuralPairs.has(k)) continue;
    if (!pos[a] || !pos[b]) continue;
    const cur = extraByPair.get(k);
    if (!cur || e.ts > cur.ts) extraByPair.set(k, e);
  }

  return (
    <div className="topo-scroll">
      <div className="topo-container" ref={containerRef}>

        {/* SVG overlay — connection lines + moving pulses */}
        <svg
          style={{
            position: "absolute", top: 0, left: 0,
            width: svgSize.w || "100%", height: svgSize.h || "100%",
            pointerEvents: "none", overflow: "visible", zIndex: 0,
          }}
        >
          <defs>
            {Object.entries(FLOW_COLOR).map(([flow, color]) => (
              <marker
                key={flow} id={`ah-${flow}`}
                viewBox="0 0 10 10" refX="8" refY="5"
                markerWidth="7" markerHeight="7" orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
              </marker>
            ))}
          </defs>

          {structuralEdges}
          {[...extraByPair.entries()].map(([k, e]) =>
            renderEdge(vid(e.from), vid(e.to), e, false, `extra-${k}`))}

          {/* 이동 펄스: 어떤 정보가 어디서 어디로 가는지 */}
          {pulses.map((p) => {
            const pts = anchorBetween(vid(p.from), vid(p.to));
            if (!pts) return null;
            const path = `M ${pts.from.x} ${pts.from.y} L ${pts.to.x} ${pts.to.y}`;
            return <PulseDot key={p.id} pulse={p} path={path} />;
          })}
        </svg>

        {/* ── User request node ── */}
        {taskIO?.request && (
          <div className="topo-user-row">
            <div ref={setNodeRef("user")}>
              <UserNode request={taskIO.request} done={taskIO.result != null} />
            </div>
          </div>
        )}

        {/* ── Hub row ── */}
        {hubAgent && hubV && (
          <div className="topo-hub-row">
            <ActivityStack items={hubV.acts} />
            <div ref={setNodeRef(hubAgent.id)} style={{ zIndex: 1 }}>
              <AgentCard
                meta={hubV.meta} online={hubV.online}
                thinking={hubV.thinking} busy={hubV.busy} toolName={hubV.toolName}
              />
            </div>
          </div>
        )}

        {/* ── Worker row — 동적으로 늘어나는 에이전트 ── */}
        {workers.length > 0 && (
          <div className="topo-worker-row">
            {workers.map((w, i) => {
              const v = visual(w);
              const side = i < workers.length / 2 ? "stack-left" : "stack-right";
              return (
                <div key={w.id} className={`topo-agent-block ${side}`}>
                  <ActivityStack items={v.acts} />
                  <div ref={setNodeRef(w.id)} style={{ zIndex: 1 }}>
                    <AgentCard
                      meta={v.meta} online={v.online}
                      thinking={v.thinking} busy={v.busy} toolName={v.toolName}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Blackboard ── */}
        {hasBB && (
          <div className="topo-bb-row">
            <div ref={setNodeRef("bb")} style={{ width: "100%", maxWidth: 560, zIndex: 1 }}>
              <BBNode blackboard={blackboard} edgeList={edgeList} agents={agents} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

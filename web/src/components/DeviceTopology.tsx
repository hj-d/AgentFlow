import { useEffect, useRef, useState, useMemo } from "react";
import {
  useStore, ACTIVITY_TTL_MS, EDGE_TTL_MS, THINKING_TTL_MS,
  type PulseFlow, type EdgeState,
} from "../store";

interface CardPos { x: number; y: number; w: number; h: number; cx: number; cy: number }

const AGENTS = [
  { id: "pc",  name: "PC Agent", role: "Creator",      cls: "pc" },
  { id: "hub", name: "HomeHub",  role: "Orchestrator", cls: "hub" },
  { id: "tv",  name: "TV Agent", role: "Display",      cls: "tv" },
];

const PULSE_DUR = 1000;

// ---- Thinking dots ----
function ThinkDots({ cls = "" }: { cls?: string }) {
  return (
    <div className={`think-dots ${cls}`}>
      <span className="td" /><span className="td" /><span className="td" />
    </div>
  );
}

// ---- PC Monitor ----
function PCCard({ online, thinking, busy, toolName }: {
  online: boolean; thinking: boolean; busy: boolean; toolName?: string;
}) {
  return (
    <div className="dev-illus pc-illus">
      <div className={`pc-monitor ${busy ? "busy" : ""}`}>
        <div className="pc-screen">
          {thinking
            ? <ThinkDots cls="pc" />
            : busy && toolName
              ? <div className="screen-running"><span className="s-spin">⚙</span><span className="s-name">{toolName}</span></div>
              : <div className="screen-idle"><span /><span /><span /></div>
          }
        </div>
      </div>
      <div className="pc-neck" />
      <div className="pc-base" />
    </div>
  );
}

// ---- Hub Router ----
function HubCard({ online, thinking, busy, toolName }: {
  online: boolean; thinking: boolean; busy: boolean; toolName?: string;
}) {
  const s = thinking ? "think" : busy ? "busy" : online ? "on" : "off";
  return (
    <div className="dev-illus hub-illus">
      {thinking && <div className="hub-think-bubble"><ThinkDots cls="hub" /></div>}
      <div className="hub-ants">
        <span className="ant s" /><span className="ant t" /><span className="ant s" />
      </div>
      <div className={`hub-chassis ${busy ? "busy" : ""}`}>
        <span className={`hled l1 ${s}`} />
        <span className={`hled l2 ${s}`} />
        <span className={`hled l3 ${s}`} />
      </div>
      {busy && !thinking && toolName && (
        <div className="hub-tool-tag"><span className="s-spin">⚙</span> {toolName}</div>
      )}
    </div>
  );
}

// ---- TV ----
function TVCard({ online, thinking, busy, toolName }: {
  online: boolean; thinking: boolean; busy: boolean; toolName?: string;
}) {
  return (
    <div className="dev-illus tv-illus">
      <div className={`tv-bezel ${busy ? "busy" : ""}`}>
        <div className="tv-screen">
          {thinking
            ? <ThinkDots cls="tv" />
            : busy && toolName
              ? <div className="screen-running tv"><span className="s-spin">⚙</span><span className="s-name">{toolName}</span></div>
              : <div className="tv-idle"><span /><span className="w" /></div>
          }
        </div>
        <div className="tv-led-bar">
          <span className={`tv-pwr ${online ? "on" : "off"}`} />
        </div>
      </div>
      <div className="tv-legs"><span className="tvleg" /><span className="tvleg" /></div>
    </div>
  );
}

// ============================================================

export function DeviceTopology() {
  const agents     = useStore((s) => s.agents);
  const pulses     = useStore((s) => s.pulses);
  const edges      = useStore((s) => s.edges);
  const blackboard = useStore((s) => s.blackboard);
  const expirePulses   = useStore((s) => s.expirePulses);
  const expireEdges    = useStore((s) => s.expireEdges);
  const expireActivity = useStore((s) => s.expireActivity);
  const [, tick] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const bbRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Record<string, CardPos>>({});
  const [bbPos, setBbPos] = useState<CardPos | null>(null);

  // RAF loop – pulses, edges, activity expiry
  const rafRef = useRef<number>(0);
  useEffect(() => {
    const loop = () => {
      expirePulses(performance.now());
      expireEdges(Date.now());
      expireActivity(Date.now());
      tick((n) => (n + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [expirePulses, expireEdges, expireActivity]);

  // Measure card positions
  useEffect(() => {
    const measure = () => {
      const cr = containerRef.current?.getBoundingClientRect();
      if (!cr) return;
      const next: Record<string, CardPos> = {};
      for (const a of AGENTS) {
        const el = cardRefs.current[a.id];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const x = r.left - cr.left, y = r.top - cr.top;
        next[a.id] = { x, y, w: r.width, h: r.height, cx: x + r.width / 2, cy: y + r.height / 2 };
      }
      setPos(next);
      const bbEl = bbRef.current;
      if (bbEl) {
        const r = bbEl.getBoundingClientRect();
        const x = r.left - cr.left, y = r.top - cr.top;
        setBbPos({ x, y, w: r.width, h: r.height, cx: x + r.width / 2, cy: y + r.height / 2 });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const now  = performance.now();
  const wall = Date.now();
  const edgeList = useMemo(() => Object.values(edges), [edges]);

  // Best recent edge between two abstract nodes
  function bestEdge(f: string, t: string): EdgeState | null {
    let best: EdgeState | null = null;
    for (const e of edgeList) {
      const m = (e.from === f && e.to === t) || (e.from === t && e.to === f);
      if (m && wall - e.ts < EDGE_TTL_MS && (!best || e.ts > best.ts)) best = e;
    }
    return best;
  }
  function bestBBEdge(agentId: string): EdgeState | null {
    let best: EdgeState | null = null;
    for (const e of edgeList) {
      const m = (e.from === agentId && e.to === "__blackboard__") ||
                (e.from === "__blackboard__" && e.to === agentId);
      if (m && wall - e.ts < EDGE_TTL_MS && (!best || e.ts > best.ts)) best = e;
    }
    return best;
  }
  function fresh(e: EdgeState) { return Math.max(0, 1 - (wall - e.ts) / EDGE_TTL_MS); }

  // ---- SVG lines ----
  function hLine(f: string, t: string) {
    const a = pos[f], b = pos[t];
    if (!a || !b) return null;
    const edge = bestEdge(f, t);
    const cls = edge?.flow ?? ("idle" as PulseFlow | "idle");
    const x1 = a.x + a.w, y1 = a.cy, x2 = b.x, y2 = b.cy, mx = (x1 + x2) / 2;
    return (
      <path key={`${f}→${t}`}
        d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
        className={`topo-edge ${cls}`}
        style={{ opacity: edge ? 0.25 + fresh(edge) * 0.65 : 0.3 }} />
    );
  }

  function bbLine(agentId: string) {
    const a = pos[agentId];
    if (!a || !bbPos) return null;
    const edge = bestBBEdge(agentId);
    const cls = edge?.flow ?? ("idle" as PulseFlow | "idle");
    const x1 = a.cx, y1 = a.y + a.h;
    let x2 = bbPos.cx;
    if (agentId === "pc")  x2 = bbPos.x + bbPos.w * 0.22;
    if (agentId === "tv")  x2 = bbPos.x + bbPos.w * 0.78;
    const y2 = bbPos.y;
    const ym = y1 + (y2 - y1) * 0.45;
    return (
      <path key={`${agentId}→bb`}
        d={`M${x1},${y1} C${x1},${ym} ${x2},${ym} ${x2},${y2}`}
        className={`topo-edge ${cls}`}
        style={{ opacity: edge ? 0.25 + fresh(edge) * 0.65 : 0.18, strokeDasharray: !edge ? "5 3" : "none" }} />
    );
  }

  // ---- Bezier point ----
  function bz(x1: number, y1: number, cx1: number, cy1: number, cx2: number, cy2: number,
               x2: number, y2: number, t: number): [number, number] {
    const u = 1 - t;
    return [
      u*u*u*x1 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x2,
      u*u*u*y1 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y2,
    ];
  }

  function pulseXY(from: string, to: string, t: number): [number, number] | null {
    const getP = (id: string): CardPos | null => id === "__blackboard__" ? bbPos : (pos[id] ?? null);
    const a = getP(from), b = getP(to);
    if (!a || !b) return null;

    if (from === "__blackboard__" || to === "__blackboard__") {
      const isWrite = to === "__blackboard__";
      const agPos = isWrite ? a : b;
      const bbP   = isWrite ? b : a;
      const agId  = isWrite ? from : to;
      let bbX = bbP.cx;
      if (agId === "pc") bbX = bbP.x + bbP.w * 0.22;
      if (agId === "tv") bbX = bbP.x + bbP.w * 0.78;
      const [x1, y1] = isWrite ? [agPos.cx, agPos.y + agPos.h] : [bbX, bbP.y];
      const [x2, y2] = isWrite ? [bbX, bbP.y] : [agPos.cx, agPos.y + agPos.h];
      const ym = y1 + (y2 - y1) * 0.45;
      return bz(x1, y1, x1, ym, x2, ym, x2, y2, t);
    }
    const x1 = a.x + a.w, y1 = a.cy, x2 = b.x, y2 = b.cy, mx = (x1 + x2) / 2;
    return bz(x1, y1, mx, y1, mx, y2, x2, y2, t);
  }

  // ---- Render pulses + labels ----
  function renderPulses() {
    return pulses.map((p) => {
      const t = Math.min(1, (now - p.start) / PULSE_DUR);
      const xy = pulseXY(p.from, p.to, t);
      if (!xy) return null;
      const [px, py] = xy;
      const alpha = 1 - t * 0.45;
      const showLabel = !!p.label && t > 0.1 && t < 0.9;
      const lw = p.label ? Math.min(p.label.length * 6.5, 96) + 12 : 0;
      return (
        <g key={p.id}>
          <circle cx={px} cy={py} r={5} className={`topo-pulse ${p.flow}`} style={{ opacity: alpha }} />
          {showLabel && (
            <>
              <rect x={px + 8} y={py - 10} width={lw} height={17} rx="4"
                className="plabel-bg" style={{ opacity: alpha }} />
              <text x={px + 13} y={py + 3}
                className={`plabel-txt ${p.flow}`} style={{ opacity: alpha }}>
                {p.label!.length > 14 ? p.label!.slice(0, 13) + "…" : p.label}
              </text>
            </>
          )}
        </g>
      );
    });
  }

  // ---- Blackboard topology card data ----
  const bbEntries = useMemo(() =>
    Object.entries(blackboard).sort((a, b) => b[1].ts - a[1].ts).slice(0, 4),
    [blackboard]);

  function bbKeyState(key: string): "write" | "read" | null {
    for (const e of edgeList) {
      if (e.label === key && wall - e.ts < 2000) {
        if (e.flow === "bb-write") return "write";
        if (e.flow === "bb-read")  return "read";
      }
    }
    return null;
  }

  function snip(v: unknown): string {
    if (v === undefined || v === null) return "—";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 22 ? s.slice(0, 21) + "…" : s;
  }

  const containerH = containerRef.current?.offsetHeight ?? 460;
  const hasAnyAgent = AGENTS.some((a) => !!agents[a.id]);

  return (
    <div className="topology-scroll">
      <div className="topology-container" ref={containerRef}>
        {/* SVG overlay – connections + pulses */}
        <svg className="topology-svg" width="100%" height={containerH}
          style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}>
          {hLine("pc", "hub")}
          {hLine("hub", "tv")}
          {bbLine("pc")}
          {bbLine("hub")}
          {bbLine("tv")}
          {renderPulses()}
        </svg>

        {!hasAnyAgent ? (
          <div className="topology-empty">
            시뮬레이터 대기 중…<br />
            <code>npm run sim</code>
          </div>
        ) : (
          <>
            {/* Agent cards */}
            <div className="device-row">
              {AGENTS.map((spec) => {
                const agent = agents[spec.id];
                const online = agent ? agent.phase === "start" : false;
                const thinking = !!(agent?.thinking && agent.thinkingTs && wall - agent.thinkingTs < THINKING_TTL_MS);
                const busy = !!(agent?.activity?.phase === "start" && wall - (agent.activity?.ts ?? 0) < ACTIVITY_TTL_MS);
                const toolName = agent?.activity?.tool;
                const recentlyActive = !!(agent && wall - agent.lastSeen < 1500);
                return (
                  <div
                    key={spec.id}
                    ref={(el) => { cardRefs.current[spec.id] = el; }}
                    className={[
                      "device-card", spec.cls,
                      recentlyActive ? "active" : "",
                      !online && agent ? "offline" : "",
                      thinking ? "thinking" : "",
                      busy ? "busy" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    {spec.id === "pc"  && <PCCard  online={online} thinking={thinking} busy={busy} toolName={toolName} />}
                    {spec.id === "hub" && <HubCard online={online} thinking={thinking} busy={busy} toolName={toolName} />}
                    {spec.id === "tv"  && <TVCard  online={online} thinking={thinking} busy={busy} toolName={toolName} />}

                    <div className="device-name-row">
                      <span className="device-name">{spec.name}</span>
                      <span className={`hb-dot ${online ? "alive" : agent ? "dead" : "dormant"}`} />
                    </div>
                    <div className="device-role">{spec.role}</div>
                    <div className="device-color-bar" />
                  </div>
                );
              })}
            </div>

            {/* Blackboard node */}
            <div className="bb-node-wrap">
              <div className="bb-node-card" ref={bbRef}>
                <div className="bb-node-head">
                  <span className="bb-node-icon">📋</span>
                  <span className="bb-node-title">Blackboard</span>
                  {Object.keys(blackboard).length > 0 && (
                    <span className="bb-node-cnt">{Object.keys(blackboard).length}</span>
                  )}
                </div>
                {bbEntries.length === 0 ? (
                  <div className="bb-node-empty">비어있음 — 이벤트 대기 중</div>
                ) : (
                  <div className="bb-node-rows">
                    {bbEntries.map(([key, entry]) => {
                      const st = bbKeyState(key);
                      return (
                        <div key={key} className={`bb-node-row ${st ?? ""}`}>
                          {st === "write" && <span className="bb-op-badge write">W</span>}
                          {st === "read"  && <span className="bb-op-badge read">R</span>}
                          {!st && <span className="bb-op-badge idle" />}
                          <span className="bb-node-key">{key}</span>
                          <span className="bb-node-val">{snip(entry.value)}</span>
                          <span className={`bb-node-by ${entry.by}`}>{entry.by}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

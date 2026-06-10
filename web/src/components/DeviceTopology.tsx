import { useEffect, useRef, useState, useMemo } from "react";
import {
  useStore, ACTIVITY_TTL_MS, EDGE_TTL_MS, THINKING_TTL_MS,
  type PulseFlow, type EdgeState, type TaskIO,
} from "../store";
import type { FlowEvent } from "../types";

interface CardPos { x: number; y: number; w: number; h: number; cx: number; cy: number }

const AGENTS: { id: string; name: string; role: string; cls: "pc" | "hub" | "tv" }[] = [
  { id: "pc",  name: "PC Agent", role: "Creator",      cls: "pc" },
  { id: "hub", name: "HomeHub",  role: "Orchestrator", cls: "hub" },
  { id: "tv",  name: "TV Agent", role: "Display",      cls: "tv" },
];

const PULSE_DUR = 1000;

// ---- Format helpers ----
function fmtTaskResult(result: unknown): string {
  if (!result) return "완료";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const r = result as Record<string, unknown>;
  if (typeof r.message === "string") return r.message;
  const parts: string[] = [];
  if (r.video || r.file) parts.push(`🎬 ${r.video ?? r.file}`);
  if (r.duration) parts.push(`⏱ ${r.duration}`);
  return parts.join("  ·  ") || JSON.stringify(r).slice(0, 80);
}

// ---- Task I/O — horizontal directional layout ----
function TaskIOSection({ taskIO }: { taskIO: TaskIO | null }) {
  if (!taskIO?.request) return null;
  const scenLabel = taskIO.scenario === "scenario-1" ? "S1"
    : taskIO.scenario === "scenario-2" ? "S2"
    : (taskIO.scenario ?? null);
  const hasResult = taskIO.result != null;

  return (
    <div className="tio-section">
      <div className={`tio-request ${hasResult ? "has-result" : ""}`}>
        <div className="tio-header in">
          <span className="tio-dir">📥</span>
          <span className="tio-lbl">User Request</span>
          {scenLabel && <span className="tio-scen">{scenLabel}</span>}
          <span className="tio-arrow-badge">→</span>
        </div>
        <div className="tio-text">{taskIO.request}</div>
      </div>

      {hasResult ? (
        <div className="tio-response">
          <div className="tio-header out">
            <span className="tio-arrow-badge">←</span>
            <span className="tio-lbl">Hub Response</span>
            <span className="tio-done">✅</span>
            <span className="tio-dir">📤</span>
          </div>
          <div className="tio-text">{fmtTaskResult(taskIO.result)}</div>
        </div>
      ) : (
        <div className="tio-processing">
          <div className="tio-processing-dots">
            <span /><span /><span />
          </div>
          <div className="tio-processing-label">Hub 처리 중...</div>
        </div>
      )}
    </div>
  );
}

// ---- Thinking dots ----
function ThinkDots({ cls = "" }: { cls?: string }) {
  return (
    <div className={`think-dots ${cls}`}>
      <span className="td" /><span className="td" /><span className="td" />
    </div>
  );
}

// ---- PC Monitor ----
function PCIllus({ thinking, busy, toolName }: { thinking: boolean; busy: boolean; toolName?: string }) {
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
function HubIllus({ thinking, busy, toolName }: { thinking: boolean; busy: boolean; toolName?: string }) {
  const s = thinking ? "think" : busy ? "busy" : "on";
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
function TVIllus({ online, thinking, busy, toolName }: { online: boolean; thinking: boolean; busy: boolean; toolName?: string }) {
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

// ---- Activity card system ----
type ActItem = {
  key: string;
  kind: "tool" | "dispatch" | "return" | "bb-w" | "bb-r" | "msg";
  icon: string;
  typeLabel: string;
  text: string;
  cls: string;
  detail: unknown;
};

function buildActivity(events: FlowEvent[], agentId: string, taskId: string | undefined): ActItem[] {
  const items: ActItem[] = [];
  for (const e of events) {
    if (items.length >= 4) break;
    if (taskId && e.taskId && e.taskId !== taskId) continue;

    if (e.kind === "delegate") {
      if (e.from === agentId) {
        if (e.phase === "dispatch") {
          const taskSnip = e.task ? `"${e.task.slice(0, 18)}${e.task.length > 18 ? "…" : ""}"` : `→ ${e.to}`;
          items.push({ key: e.eventId, kind: "dispatch", icon: "→", typeLabel: `→ ${e.to}`, text: taskSnip, cls: "dispatch", detail: { task: e.task, to: e.to } });
        } else if (e.phase === "return") {
          items.push({ key: e.eventId, kind: "return", icon: "↩", typeLabel: `↩ ${e.to}`, text: "작업 완료 반환", cls: "return", detail: e.payload });
        }
      }
      continue;
    }
    if (e.agentId !== agentId) continue;

    if (e.kind === "tool" && e.phase === "end") {
      items.push({
        key: e.eventId,
        kind: "tool",
        icon: e.status === "error" ? "✗" : "✓",
        typeLabel: "도구 실행",
        text: e.tool,
        cls: e.status === "error" ? "err" : "ok",
        detail: e.output,
      });
    } else if (e.kind === "blackboard" && e.op === "write") {
      items.push({ key: e.eventId, kind: "bb-w", icon: "✍", typeLabel: "BB 쓰기", text: e.key, cls: "bb-w", detail: e.value });
    } else if (e.kind === "blackboard" && e.op === "read") {
      items.push({ key: e.eventId, kind: "bb-r", icon: "📖", typeLabel: "BB 읽기", text: e.key, cls: "bb-r", detail: null });
    }
  }
  return items;
}

function ActCard({ item }: { item: ActItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`act-card ${item.cls}${item.detail != null ? " clickable" : ""}`}
      onClick={() => item.detail != null && setOpen((o) => !o)}
    >
      <div className="act-card-row">
        <span className="act-card-type">{item.typeLabel}</span>
        <span className={`act-card-icon ${item.cls}`}>{item.icon}</span>
      </div>
      <div className="act-card-text">{item.text.length > 22 ? item.text.slice(0, 21) + "…" : item.text}</div>
      {open && item.detail != null && (
        <pre className="act-card-detail">{JSON.stringify(item.detail, null, 2)}</pre>
      )}
    </div>
  );
}

// ============================================================
export function DeviceTopology() {
  const agents     = useStore((s) => s.agents);
  const pulses     = useStore((s) => s.pulses);
  const edges      = useStore((s) => s.edges);
  const blackboard = useStore((s) => s.blackboard);
  const events     = useStore((s) => s.events);
  const taskIO     = useStore((s) => s.taskIO);
  const expirePulses   = useStore((s) => s.expirePulses);
  const expireEdges    = useStore((s) => s.expireEdges);
  const expireActivity = useStore((s) => s.expireActivity);
  const [, tick] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const bbRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Record<string, CardPos>>({});
  const [bbPos, setBbPos] = useState<CardPos | null>(null);

  const taskId = taskIO?.taskId;

  // RAF loop
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
    if (agentId === "pc")  x2 = bbPos.x + bbPos.w * 0.18;
    if (agentId === "tv")  x2 = bbPos.x + bbPos.w * 0.82;
    const y2 = bbPos.y;
    const ym = y1 + (y2 - y1) * 0.45;
    const dashArr = edge ? "none" : "6 4";
    return (
      <path key={`${agentId}→bb`}
        d={`M${x1},${y1} C${x1},${ym} ${x2},${ym} ${x2},${y2}`}
        className={`topo-edge ${cls} bb-cable`}
        style={{ opacity: edge ? 0.35 + fresh(edge) * 0.55 : 0.18, strokeDasharray: dashArr }} />
    );
  }

  // ---- Bezier ----
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
      if (agId === "pc") bbX = bbP.x + bbP.w * 0.18;
      if (agId === "tv") bbX = bbP.x + bbP.w * 0.82;
      const [x1, y1] = isWrite ? [agPos.cx, agPos.y + agPos.h] : [bbX, bbP.y];
      const [x2, y2] = isWrite ? [bbX, bbP.y] : [agPos.cx, agPos.y + agPos.h];
      const ym = y1 + (y2 - y1) * 0.45;
      return bz(x1, y1, x1, ym, x2, ym, x2, y2, t);
    }
    const x1 = a.x + a.w, y1 = a.cy, x2 = b.x, y2 = b.cy, mx = (x1 + x2) / 2;
    return bz(x1, y1, mx, y1, mx, y2, x2, y2, t);
  }

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

  // ---- Blackboard entries ----
  const bbEntries = useMemo(() =>
    Object.entries(blackboard).sort((a, b) => b[1].ts - a[1].ts).slice(0, 5),
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
    return s.length > 26 ? s.slice(0, 25) + "…" : s;
  }

  const bbActive = edgeList.some(e =>
    (e.to === "__blackboard__" || e.from === "__blackboard__") && wall - e.ts < 2000
  );

  const containerH = containerRef.current?.offsetHeight ?? 540;
  const hasAnyAgent = AGENTS.some((a) => !!agents[a.id]);

  // Per-agent activity items
  const actItems = useMemo(() => ({
    pc:  buildActivity(events, "pc",  taskId),
    hub: buildActivity(events, "hub", taskId),
    tv:  buildActivity(events, "tv",  taskId),
  }), [events, taskId]);

  return (
    <div className="topology-scroll">
      <div className="topology-container" ref={containerRef}>
        {/* SVG overlay */}
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
            {/* Task I/O — horizontal directional area */}
            <TaskIOSection taskIO={taskIO} />

            {/* Agent groups row */}
            <div className="device-row">

              {/* ── PC: [activity-sidebar | card] ── */}
              {(() => {
                const spec = AGENTS[0]; // pc
                const agent = agents[spec.id];
                const online = agent ? agent.phase === "start" : false;
                const thinking = !!(agent?.thinking && agent.thinkingTs && wall - agent.thinkingTs < THINKING_TTL_MS);
                const busy = !!(agent?.activity?.phase === "start" && wall - (agent.activity?.ts ?? 0) < ACTIVITY_TTL_MS);
                const toolName = agent?.activity?.tool;
                const recentlyActive = !!(agent && wall - agent.lastSeen < 1500);
                return (
                  <div className="device-group pc">
                    {/* Activities — LEFT side of PC card */}
                    <div className="act-sidebar left">
                      {actItems.pc.length === 0 ? (
                        <div className="act-sidebar-empty">대기 중</div>
                      ) : (
                        actItems.pc.map(item => <ActCard key={item.key} item={item} />)
                      )}
                    </div>
                    {/* PC card */}
                    <div
                      ref={(el) => { cardRefs.current["pc"] = el; }}
                      className={[
                        "device-card", "pc",
                        recentlyActive ? "active" : "",
                        !online && agent ? "offline" : "",
                        thinking ? "thinking" : "",
                        busy ? "busy" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <div className="device-status-bar">
                        <span className={`hb-dot ${online ? "alive" : agent ? "dead" : "dormant"}`} />
                        <span className="device-status-label">
                          {thinking ? "thinking…" : busy ? `⚙ ${toolName ?? "working"}` : online ? "online" : "offline"}
                        </span>
                      </div>
                      <PCIllus thinking={thinking} busy={busy} toolName={toolName} />
                      <div className="device-info">
                        <span className="device-name">{spec.name}</span>
                        <span className="device-role-badge">{spec.role}</span>
                      </div>
                      <div className="device-color-bar" />
                    </div>
                  </div>
                );
              })()}

              {/* ── HUB: elevated, orchestrator crown ── */}
              {(() => {
                const spec = AGENTS[1]; // hub
                const agent = agents[spec.id];
                const online = agent ? agent.phase === "start" : false;
                const thinking = !!(agent?.thinking && agent.thinkingTs && wall - agent.thinkingTs < THINKING_TTL_MS);
                const busy = !!(agent?.activity?.phase === "start" && wall - (agent.activity?.ts ?? 0) < ACTIVITY_TTL_MS);
                const toolName = agent?.activity?.tool;
                const recentlyActive = !!(agent && wall - agent.lastSeen < 1500);
                return (
                  <div className="device-group hub">
                    {/* Orchestrator crown label */}
                    <div className="hub-orch-crown">
                      🎯 <span>Orchestrator</span>
                    </div>
                    {/* Hub card */}
                    <div
                      ref={(el) => { cardRefs.current["hub"] = el; }}
                      className={[
                        "device-card", "hub",
                        recentlyActive ? "active" : "",
                        !online && agent ? "offline" : "",
                        thinking ? "thinking" : "",
                        busy ? "busy" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <div className="device-status-bar hub">
                        <span className={`hb-dot ${online ? "alive" : agent ? "dead" : "dormant"}`} />
                        <span className="device-status-label">
                          {thinking ? "thinking…" : busy ? `⚙ ${toolName ?? "working"}` : online ? "online" : "offline"}
                        </span>
                      </div>
                      <HubIllus thinking={thinking} busy={busy} toolName={toolName} />
                      <div className="device-info">
                        <span className="device-name">{spec.name}</span>
                        <span className="device-role-badge orch">{spec.role}</span>
                      </div>
                      <div className="device-color-bar" />
                    </div>
                    {/* Hub activities — horizontal below card */}
                    <div className="hub-act-row">
                      {actItems.hub.map(item => <ActCard key={item.key} item={item} />)}
                    </div>
                  </div>
                );
              })()}

              {/* ── TV: [card | activity-sidebar] ── */}
              {(() => {
                const spec = AGENTS[2]; // tv
                const agent = agents[spec.id];
                const online = agent ? agent.phase === "start" : false;
                const thinking = !!(agent?.thinking && agent.thinkingTs && wall - agent.thinkingTs < THINKING_TTL_MS);
                const busy = !!(agent?.activity?.phase === "start" && wall - (agent.activity?.ts ?? 0) < ACTIVITY_TTL_MS);
                const toolName = agent?.activity?.tool;
                const recentlyActive = !!(agent && wall - agent.lastSeen < 1500);
                return (
                  <div className="device-group tv">
                    {/* TV card */}
                    <div
                      ref={(el) => { cardRefs.current["tv"] = el; }}
                      className={[
                        "device-card", "tv",
                        recentlyActive ? "active" : "",
                        !online && agent ? "offline" : "",
                        thinking ? "thinking" : "",
                        busy ? "busy" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <div className="device-status-bar">
                        <span className={`hb-dot ${online ? "alive" : agent ? "dead" : "dormant"}`} />
                        <span className="device-status-label">
                          {thinking ? "thinking…" : busy ? `⚙ ${toolName ?? "working"}` : online ? "online" : "offline"}
                        </span>
                      </div>
                      <TVIllus online={online} thinking={thinking} busy={busy} toolName={toolName} />
                      <div className="device-info">
                        <span className="device-name">{spec.name}</span>
                        <span className="device-role-badge">{spec.role}</span>
                      </div>
                      <div className="device-color-bar" />
                    </div>
                    {/* Activities — RIGHT side of TV card */}
                    <div className="act-sidebar right">
                      {actItems.tv.length === 0 ? (
                        <div className="act-sidebar-empty">대기 중</div>
                      ) : (
                        actItems.tv.map(item => <ActCard key={item.key} item={item} />)
                      )}
                    </div>
                  </div>
                );
              })()}

            </div>

            {/* Blackboard Server — below, compact */}
            <div className="bb-server-wrap">
              <div className="bb-server" ref={bbRef}>
                <div className="bb-rack-bar">
                  <div className="bb-rack-leds">
                    <span className="bb-rack-led pwr" />
                    <span className={`bb-rack-led net ${bbActive ? "active" : ""}`} />
                    <span className={`bb-rack-led hdd ${bbActive ? "active" : ""}`} />
                  </div>
                  <div className="bb-rack-label">BLACKBOARD SERVER</div>
                  <div className="bb-rack-slot" />
                </div>
                <div className="bb-server-body">
                  <div className="bb-server-head">
                    <span className="bb-server-icon">🗄️</span>
                    <div className="bb-server-title-wrap">
                      <div className="bb-server-title">Shared State</div>
                      <div className="bb-server-sub">Key-Value Store</div>
                    </div>
                    {Object.keys(blackboard).length > 0 && (
                      <span className="bb-server-cnt">{Object.keys(blackboard).length} keys</span>
                    )}
                  </div>
                  {bbEntries.length === 0 ? (
                    <div className="bb-server-empty">No data — waiting for writes</div>
                  ) : (
                    <div className="bb-server-rows">
                      {bbEntries.map(([key, entry]) => {
                        const st = bbKeyState(key);
                        return (
                          <div key={key} className={`bb-server-row ${st ?? ""}`}>
                            <span className={`bb-op-badge ${st ?? "idle"}`}>{st === "write" ? "W" : st === "read" ? "R" : ""}</span>
                            <span className="bb-server-key">{key}</span>
                            <span className="bb-server-val">{snip(entry.value)}</span>
                            <span className={`bb-server-by ${entry.by}`}>{entry.by}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

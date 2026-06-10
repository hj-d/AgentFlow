import { useEffect, useRef, useState, useMemo } from "react";
import { useStore, ACTIVITY_TTL_MS, EDGE_TTL_MS, type PulseFlow } from "../store";

interface CardPos { x: number; y: number; w: number; h: number; cx: number; cy: number }

const AGENTS = [
  { id: "pc",  icon: "🖥️",  name: "PC Agent",  role: "Creator",      cls: "pc" },
  { id: "hub", icon: "📡",  name: "HomeHub",    role: "Orchestrator", cls: "hub" },
  { id: "tv",  icon: "📺",  name: "TV Agent",   role: "Display",      cls: "tv" },
];

const PULSE_DUR = 900;

export function DeviceTopology() {
  const agents    = useStore((s) => s.agents);
  const pulses    = useStore((s) => s.pulses);
  const edges     = useStore((s) => s.edges);
  const expirePulses   = useStore((s) => s.expirePulses);
  const expireEdges    = useStore((s) => s.expireEdges);
  const expireActivity = useStore((s) => s.expireActivity);
  const [, forceUpdate] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [positions, setPositions] = useState<Record<string, CardPos>>({});

  // RAF loop for pulse animation + expiry
  const rafRef = useRef<number>(0);
  useEffect(() => {
    const loop = () => {
      expirePulses(performance.now());
      expireEdges(Date.now());
      expireActivity(Date.now());
      forceUpdate((n) => (n + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [expirePulses, expireEdges, expireActivity]);

  // Measure card positions whenever layout changes
  useEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const next: Record<string, CardPos> = {};
      for (const a of AGENTS) {
        const el = cardRefs.current[a.id];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const x = r.left - cr.left;
        const y = r.top  - cr.top;
        next[a.id] = { x, y, w: r.width, h: r.height, cx: x + r.width / 2, cy: y + r.height / 2 };
      }
      setPositions(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const agentMap = agents;
  const now = performance.now();
  const wall = Date.now();

  const edgeList = useMemo(() => Object.values(edges), [edges]);

  // Determine active connection style between two nodes
  function activeFlow(from: string, to: string): PulseFlow | null {
    // Find most recent edge between these two
    let best: { ts: number; flow: PulseFlow } | null = null;
    for (const e of edgeList) {
      const matches = (e.from === from && e.to === to) || (e.from === to && e.to === from);
      if (matches && wall - e.ts < EDGE_TTL_MS) {
        if (!best || e.ts > best.ts) best = { ts: e.ts, flow: e.flow };
      }
    }
    return best?.flow ?? null;
  }

  function renderLine(from: string, to: string) {
    const a = positions[from];
    const b = positions[to];
    if (!a || !b) return null;
    const flow = activeFlow(from, to);
    const cls = flow ?? "idle";
    // right edge of 'from' card to left edge of 'to' card
    const x1 = a.x + a.w;
    const y1 = a.cy;
    const x2 = b.x;
    const y2 = b.cy;
    const mx = (x1 + x2) / 2;
    const fresh = flow ? Math.max(0, 1 - (wall - (edgeList.find(e => e.flow === flow && ((e.from === from && e.to === to) || (e.from === to && e.to === from)))?.ts ?? 0)) / EDGE_TTL_MS) : 0;
    return (
      <g key={`${from}-${to}`}>
        <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} className={`topo-edge ${cls}`} style={{ opacity: flow ? 0.15 + fresh * 0.65 : 0.4 }} />
      </g>
    );
  }

  function renderPulses() {
    return pulses.map((p) => {
      const a = positions[p.from];
      const b = positions[p.to];
      if (!a || !b) return null;
      const t = Math.min(1, (now - p.start) / PULSE_DUR);
      // parametric bezier point
      const x1 = a.x + a.w; const y1 = a.cy;
      const x2 = b.x;        const y2 = b.cy;
      const mx = (x1 + x2) / 2;
      const u = 1 - t;
      const cx1 = mx; const cy1 = y1;
      const cx2 = mx; const cy2 = y2;
      const px = u*u*u*x1 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x2;
      const py = u*u*u*y1 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y2;
      return <circle key={p.id} cx={px} cy={py} r={5} className={`topo-pulse ${p.flow}`} style={{ opacity: 1 - t * 0.6 }} />;
    });
  }

  const containerH = containerRef.current?.offsetHeight ?? 300;

  return (
    <div className="topology-scroll">
      <div className="topology-container" ref={containerRef} style={{ height: "100%", minHeight: 200 }}>
        {/* SVG overlay for lines + pulses */}
        <svg
          className="topology-svg"
          width="100%"
          height={containerH}
          style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
        >
          {renderLine("pc", "hub")}
          {renderLine("hub", "tv")}
          {renderPulses()}
        </svg>

        {/* Device cards */}
        <div className="device-row" style={{ height: "100%", position: "relative", zIndex: 1 }}>
          {AGENTS.map((spec) => {
            const agent = agentMap[spec.id];
            const online = agent ? agent.phase === "start" : false;
            const busy = agent?.activity && agent.activity.phase === "start" && wall - agent.activity.ts < ACTIVITY_TTL_MS;
            const recentlyActive = agent && wall - agent.lastSeen < 1500;

            return (
              <div
                key={spec.id}
                ref={(el) => { cardRefs.current[spec.id] = el; }}
                className={`device-card ${spec.cls}${recentlyActive ? " active" : ""}${!online && agent ? " offline" : ""}`}
              >
                <div className="device-icon">{spec.icon}</div>
                <div className="device-name">{spec.name}</div>
                <div className="device-role">{spec.role}</div>
                <div className="device-status">
                  <span className={`status-dot ${online ? "online" : "offline"}`} />
                  <span style={{ color: online ? "#16a34a" : "var(--muted)" }}>
                    {online ? "online" : agent ? "offline" : "waiting…"}
                  </span>
                </div>
                {busy ? (
                  <div className="device-activity">
                    <span className="spin">⚙</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{agent!.activity!.tool}</span>
                  </div>
                ) : (
                  <div className="device-empty">—</div>
                )}
                <div className="device-color-bar" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

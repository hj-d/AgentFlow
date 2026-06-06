import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

/** Dropdown of active workspaces (from the server directory). Pick one to switch
 *  (isolated page), or type a new name to create one. Reflected in ?space=… */
export function SpaceSwitcher() {
  const space = useStore((s) => s.space);
  const spaces = useStore((s) => s.spaces);
  const joinSpace = useStore((s) => s.joinSpace);
  const deleteSpace = useStore((s) => s.deleteSpace);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const go = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    const url = new URL(location.href);
    url.searchParams.set("space", v);
    history.replaceState(null, "", url.toString());
    if (v !== space) joinSpace(v);
    setOpen(false);
    setQ("");
  };

  const byName = Object.fromEntries(spaces.map((s) => [s.space, s] as const));
  // always include the current workspace even if it has no events yet
  const names = Array.from(new Set([space, ...spaces.map((s) => s.space)])).sort();
  const filtered = names.filter((n) => n.toLowerCase().includes(q.toLowerCase()));
  const canCreate = q.trim() && !names.includes(q.trim());

  return (
    <div className="space-switcher" ref={ref}>
      <button className="ws-btn" onClick={() => setOpen((o) => !o)} title="워크스페이스 전환">
        ⧉ <b>{space}</b> <span className="caret">▾</span>
      </button>
      {open && (
        <div className="ws-menu">
          <input
            autoFocus
            className="ws-search"
            placeholder="검색 또는 새 워크스페이스…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(q || space);
              else if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="ws-items">
            {filtered.map((n) => {
              const info = byName[n];
              return (
                <div key={n} className={"ws-item" + (n === space ? " cur" : "")} onClick={() => go(n)}>
                  <span className="ws-name">{n === space ? "● " : ""}{n}</span>
                  <span className="ws-count">{info ? `${info.agents}a / ${info.tasks}t` : "비어있음"}</span>
                  {info && (
                    <button
                      className="ws-del"
                      title="이 워크스페이스 삭제"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`워크스페이스 "${n}" 를 삭제할까요?`)) deleteSpace(n);
                      }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              );
            })}
            {canCreate && (
              <div className="ws-item create" onClick={() => go(q)}>
                ＋ "{q.trim()}" 새로 만들기
              </div>
            )}
            {filtered.length === 0 && !canCreate && <div className="ws-empty">활성 워크스페이스 없음</div>}
          </div>
        </div>
      )}
    </div>
  );
}

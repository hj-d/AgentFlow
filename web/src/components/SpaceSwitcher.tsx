import { useStore } from "../store";

/** Switch the workspace (isolated page). Type a new name + Enter to create one;
 *  the choice is reflected in the URL (?space=…) so links are shareable. */
export function SpaceSwitcher() {
  const space = useStore((s) => s.space);
  const spaces = useStore((s) => s.spaces);
  const joinSpace = useStore((s) => s.joinSpace);

  const go = (raw: string) => {
    const v = raw.trim() || "default";
    if (v === space) return;
    const url = new URL(location.href);
    url.searchParams.set("space", v);
    history.replaceState(null, "", url.toString());
    joinSpace(v);
  };

  return (
    <span className="space-switcher">
      <span className="ws-label">⧉ workspace</span>
      <input
        key={space}
        list="ws-list"
        defaultValue={space}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => go(e.target.value)}
        title="이름 입력 후 Enter — 다른 테스터와 격리된 워크스페이스로 전환/생성"
      />
      <datalist id="ws-list">
        {spaces.map((s) => (
          <option key={s.space} value={s.space}>
            {`${s.space} — ${s.agents} agents / ${s.tasks} tasks`}
          </option>
        ))}
      </datalist>
    </span>
  );
}

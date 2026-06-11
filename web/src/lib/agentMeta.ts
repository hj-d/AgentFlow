// Device-type mapping — label(우선) / id(보조) 기반으로 에이전트의 디바이스 종류를 판별한다.
// Hub / PC / TV / Mobile 은 전용 스타일, 그 외는 모두 common 으로 표시.

export type DeviceType = "hub" | "pc" | "tv" | "mobile" | "common";

export interface AgentMeta {
  type: DeviceType;
  cls: DeviceType;   // CSS class (== type)
  icon: string;
  name: string;      // display name
  role: string;      // role caption
}

const TYPE_SPEC: Record<DeviceType, { icon: string; roleLabel: string }> = {
  hub:    { icon: "🏠", roleLabel: "Orchestrator" },
  pc:     { icon: "💻", roleLabel: "Creator" },
  tv:     { icon: "📺", roleLabel: "Display" },
  mobile: { icon: "📱", roleLabel: "Mobile" },
  common: { icon: "🤖", roleLabel: "Agent" },
};

function matchType(key: string): DeviceType | null {
  const k = key.toLowerCase();
  if (k.includes("hub")) return "hub";
  if (k.includes("pc") || k.includes("desktop") || k.includes("computer")) return "pc";
  if (k.includes("tv")) return "tv";
  if (k.includes("mobile") || k.includes("phone")) return "mobile";
  return null;
}

export function deviceTypeOf(id: string, label?: string, role?: string): DeviceType {
  if (role?.toLowerCase() === "orchestrator") return "hub";
  // label 우선 매칭, 매칭 실패 시 id로 한 번 더 시도, 그래도 없으면 common
  return (label ? matchType(label) : null) ?? matchType(id) ?? "common";
}

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function getAgentMeta(
  id: string,
  info?: { label?: string; role?: string },
): AgentMeta {
  const type = deviceTypeOf(id, info?.label, info?.role);
  const spec = TYPE_SPEC[type];
  return {
    type,
    cls: type,
    icon: spec.icon,
    name: info?.label ?? capitalize(id),
    role: info?.role ? capitalize(info.role) : spec.roleLabel,
  };
}

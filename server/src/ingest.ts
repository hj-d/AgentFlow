import { makeEventId } from "./id.js";
import type { FlowEvent, FlowEventInput } from "./types.js";

export function isValidInput(raw: unknown): raw is FlowEventInput {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.agentId !== "string" || !e.agentId) return false;

  switch (e.kind) {
    case "agent":
      return e.phase === "start" || e.phase === "end";
    case "tool":
      return (typeof e.tool === "string" && !!e.tool) &&
             (e.phase === "start" || e.phase === "end");
    case "delegate":
      return (e.phase === "dispatch" || e.phase === "return") &&
             typeof e.from === "string" && !!e.from &&
             typeof e.to === "string" && !!e.to;
    case "blackboard":
      return (e.op === "read" || e.op === "write") &&
             typeof e.key === "string" && !!e.key;
    case "noti":
      return (e.phase === "broadcast" || e.phase === "ack") &&
             typeof e.from === "string" && !!e.from &&
             e.to != null;
    case "task":
      return e.phase === "input" || e.phase === "output";
    default:
      return false;
  }
}

export function normalize(input: FlowEventInput, now: number): FlowEvent {
  const ts = typeof input.ts === "number" ? input.ts : now;
  const eventId = input.eventId ?? makeEventId(ts);
  return { ...input, ts, eventId } as FlowEvent;
}

export function ingestBatch(body: unknown, now: number): FlowEvent[] {
  const items: unknown[] = Array.isArray(body) ? body : [body];
  const out: FlowEvent[] = [];
  for (const raw of items) {
    if (isValidInput(raw)) out.push(normalize(raw, now));
  }
  return out;
}

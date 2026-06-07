import { makeEventId } from "./id.js";
import type { FlowEvent, FlowEventInput } from "./types.js";

/** Returns true if the raw payload has the minimum required fields to be accepted. */
export function isValidInput(raw: unknown): raw is FlowEventInput {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  if (e.kind !== "message" && e.kind !== "blackboard" && e.kind !== "agent" && e.kind !== "tool") return false;
  if (typeof e.deviceId !== "string" || !e.deviceId) return false;
  if (typeof e.teamId !== "string" || !e.teamId) return false;
  if (typeof e.agentId !== "string" || !e.agentId) return false;

  if (e.kind === "message") {
    // 'from' required; 'to' may be null (broadcast handled upstream) but key must exist
    if (typeof e.from !== "string" || !e.from) return false;
    if (!("to" in e)) return false;
  } else if (e.kind === "blackboard") {
    if (typeof e.op !== "string") return false;
    if (typeof e.key !== "string" || !e.key) return false;
  } else if (e.kind === "tool") {
    if (typeof e.tool !== "string" || !e.tool) return false;
  } else {
    // agent lifecycle
    if (e.status !== "online" && e.status !== "offline") return false;
  }
  return true;
}

/** Fill in collector-assigned fields (eventId, ts) if the producer omitted them. */
export function normalize(input: FlowEventInput, now: number): FlowEvent {
  const ts = typeof input.ts === "number" ? input.ts : now;
  const eventId = input.eventId ?? makeEventId(ts);
  return { ...input, ts, eventId } as FlowEvent;
}

/**
 * Validate + normalize a batch. Invalid items are dropped (not thrown) so a
 * single bad producer event never breaks the whole batch.
 */
export function ingestBatch(body: unknown, now: number): FlowEvent[] {
  const items: unknown[] = Array.isArray(body) ? body : [body];
  const out: FlowEvent[] = [];
  for (const raw of items) {
    if (isValidInput(raw)) out.push(normalize(raw, now));
  }
  return out;
}

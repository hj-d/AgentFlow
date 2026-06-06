// Monotonic, sortable-ish id without external deps.
// Format: <base36 timestamp>-<base36 counter>-<rand>
let counter = 0;

export function makeEventId(now: number): string {
  counter = (counter + 1) % 0xffffff;
  const rand = Math.floor(Math.random() * 0xffff).toString(36);
  return `${now.toString(36)}-${counter.toString(36)}-${rand}`;
}

// Break length stays fixed. A new focus stores its own minutes. 1500 is only the old 25-minute start.
export const FOCUS_SECONDS = 1500;
export const BREAK_SECONDS = 300;
export const DEFAULT_FOCUS_MINUTES = 25;
export const MIN_FOCUS_MINUTES = 1;
export const MAX_FOCUS_MINUTES = 180;
/** How long a paused session stays on the default board. Roll-off is a projection, not an event. */
export const PAUSED_ROLL_OFF_MS = 3 * 24 * 60 * 60 * 1000;

export const endsAtIso = (startMs: number, focusSeconds = FOCUS_SECONDS): string =>
  new Date(startMs + focusSeconds * 1000).toISOString();

/** Planned length of a start event. No `data.minutes` reads as 25. The line itself is not rewritten. */
export function readFocusMinutes(data: { minutes?: unknown }): number {
  const m = data.minutes;
  if (typeof m === "number" && Number.isInteger(m) && m >= MIN_FOCUS_MINUTES && m <= MAX_FOCUS_MINUTES) return m;
  return DEFAULT_FOCUS_MINUTES;
}
export const remainingSeconds = (untilMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((untilMs - nowMs) / 1000));

// Pomodoro timing. Both lengths are fixed product invariants.
export const FOCUS_SECONDS = 1500;
export const BREAK_SECONDS = 300;
/** How long a paused session stays on the default board. Roll-off is a projection, not an event. */
export const PAUSED_ROLL_OFF_MS = 3 * 24 * 60 * 60 * 1000;

export const endsAtIso = (startMs: number): string => new Date(startMs + FOCUS_SECONDS * 1000).toISOString();
export const remainingSeconds = (untilMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((untilMs - nowMs) / 1000));

// Session projection (list, status). A pure fold over the log; replaying the JSONL must reach the same state.
import { EVENT_TYPES, inFoldOrder, type SessionEvent } from "./log.ts";
import { BREAK_SECONDS, PAUSED_ROLL_OFF_MS, readFocusMinutes, remainingSeconds } from "./timer.ts";

export interface TaskView {
  task_id: string;
  title: string;
  estimate_pomodoros?: number;
  notes?: string;
  status: "open" | "completed";
}
export interface PausedCard {
  pomodoro_id: string;
  task_id: string;
  task_title: string | null;
  remaining_seconds: number;
  paused_at: string;
  age_ms: number;
}
export interface Board {
  phase: "idle" | "focus" | "break" | "paused";
  task_id: string | null;
  task_title: string | null;
  pomodoro_id: string | null;
  remaining_seconds: number;
  /** Planned focus length of the current focus or paused session. Null when the board is idle or on a break. */
  focus_minutes: number | null;
  paused: PausedCard[];
}
export type Status = Board;
interface Running {
  pomodoro_id: string;
  task_id: string;
  endsAtMs: number;
  actor: SessionEvent["actor"];
  focusMinutes: number;
}
interface Finished { task_id: string; atMs: number }
interface Paused {
  pomodoro_id: string;
  task_id: string;
  remaining_seconds: number;
  pausedAtMs: number;
  focusMinutes: number;
}

const byPausedAsc = (a: PausedCard, b: PausedCard) =>
  a.paused_at < b.paused_at ? -1 : a.paused_at > b.paused_at ? 1 : a.pomodoro_id < b.pomodoro_id ? -1 : a.pomodoro_id > b.pomodoro_id ? 1 : 0;

export class Projection {
  private tasks = new Map<string, TaskView>();
  running: Running | null = null;
  private finished: Finished | null = null;
  private paused: Paused[] = [];

  apply(e: SessionEvent): void {
    const d = e.data as Record<string, any>;
    switch (e.type) {
      case EVENT_TYPES.taskImported:
      case EVENT_TYPES.taskAdded: {
        // Applied in recorded-time order, so this later event replaces an earlier edit of the same task.
        const t: TaskView = { task_id: d.task_id, title: d.title, status: "open" };
        if (d.estimate_pomodoros !== undefined) t.estimate_pomodoros = d.estimate_pomodoros;
        if (d.notes !== undefined) t.notes = d.notes;
        this.tasks.set(d.task_id, t);
        break;
      }
      case EVENT_TYPES.taskCompleted: {
        const t = this.tasks.get(d.task_id);
        if (t) t.status = "completed";
        break;
      }
      case EVENT_TYPES.pomodoroStarted:
        this.running = {
          pomodoro_id: d.pomodoro_id, task_id: d.task_id, endsAtMs: Date.parse(d.ends_at),
          actor: e.actor, focusMinutes: readFocusMinutes(d),
        };
        this.finished = null;
        break;
      case EVENT_TYPES.pomodoroPaused: {
        const running = this.running;
        if (!running || running.pomodoro_id !== d.pomodoro_id) break;
        const task_id = running.task_id;
        this.running = null;
        this.paused = this.paused.filter((p) => p.pomodoro_id !== d.pomodoro_id);
        this.paused.push({
          pomodoro_id: d.pomodoro_id,
          task_id,
          remaining_seconds: typeof d.remaining_seconds === "number" ? d.remaining_seconds : 0,
          pausedAtMs: Date.parse(e.time),
          focusMinutes: running.focusMinutes,
        });
        break;
      }
      case EVENT_TYPES.pomodoroResumed: {
        const held = this.paused.find((p) => p.pomodoro_id === d.pomodoro_id);
        if (!held) break;
        this.paused = this.paused.filter((p) => p.pomodoro_id !== d.pomodoro_id);
        this.running = {
          pomodoro_id: held.pomodoro_id, task_id: held.task_id, endsAtMs: Date.parse(d.ends_at),
          actor: e.actor, focusMinutes: held.focusMinutes,
        };
        this.finished = null;
        break;
      }
      case EVENT_TYPES.pomodoroStopped:
        if (this.running?.pomodoro_id === d.pomodoro_id) this.running = null;
        this.paused = this.paused.filter((p) => p.pomodoro_id !== d.pomodoro_id);
        break;
      case EVENT_TYPES.pomodoroFinished:
        if (this.running?.pomodoro_id === d.pomodoro_id) {
          this.running = null;
          this.finished = { task_id: d.task_id, atMs: Date.parse(e.time) };
        }
        break;
    }
  }

  task(id: string): TaskView | undefined { return this.tasks.get(id); }
  hasTask(id: string): boolean { return this.tasks.has(id); }
  findPaused(id: string): Paused | undefined { return this.paused.find((p) => p.pomodoro_id === id); }

  /** In-window paused sessions, newest pause first. Age equal to the window is already outside it. */
  inWindowPaused(nowMs: number, windowMs: number): Paused[] {
    return this.paused
      .filter((p) => nowMs - p.pausedAtMs < windowMs)
      .sort((a, b) => b.pausedAtMs - a.pausedAtMs || (a.pomodoro_id < b.pomodoro_id ? 1 : a.pomodoro_id > b.pomodoro_id ? -1 : 0));
  }

  list(status?: "open" | "completed"): TaskView[] {
    return [...this.tasks.values()].filter((t) => status === undefined || t.status === status).map((t) => ({ ...t }));
  }

  /**
   * Board fold. `nowMs` is the only clock. A paused session with age >= `pausedRollOffMs`
   * is omitted unless `includeStale`. Roll-off does not read or write the log.
   */
  board(nowMs: number, pausedRollOffMs: number, includeStale: boolean): Board {
    const cards = this.paused.map((p) => this.card(p, nowMs)).sort(byPausedAsc);
    const visible = includeStale ? cards : cards.filter((c) => c.age_ms < pausedRollOffMs);
    const empty = { task_id: null, task_title: null, pomodoro_id: null, remaining_seconds: 0, focus_minutes: null, paused: visible };
    if (this.running) {
      return {
        phase: "focus", task_id: this.running.task_id, task_title: this.tasks.get(this.running.task_id)?.title ?? null,
        pomodoro_id: this.running.pomodoro_id, remaining_seconds: remainingSeconds(this.running.endsAtMs, nowMs),
        focus_minutes: this.running.focusMinutes, paused: visible,
      };
    }
    if (this.finished) {
      const left = remainingSeconds(this.finished.atMs + BREAK_SECONDS * 1000, nowMs);
      if (left > 0) {
        return {
          phase: "break", task_id: this.finished.task_id, task_title: this.tasks.get(this.finished.task_id)?.title ?? null,
          pomodoro_id: null, remaining_seconds: left, focus_minutes: null, paused: visible,
        };
      }
    }
    const current = this.inWindowPaused(nowMs, pausedRollOffMs)[0];
    if (current) {
      const card = this.card(current, nowMs);
      return {
        phase: "paused", task_id: card.task_id, task_title: card.task_title,
        pomodoro_id: card.pomodoro_id, remaining_seconds: card.remaining_seconds,
        focus_minutes: current.focusMinutes, paused: visible,
      };
    }
    return { phase: "idle", ...empty };
  }

  /** Default board: the 3-day window, stale paused sessions omitted. */
  status(nowMs: number): Status {
    return this.board(nowMs, PAUSED_ROLL_OFF_MS, false);
  }

  private card(p: Paused, nowMs: number): PausedCard {
    return {
      pomodoro_id: p.pomodoro_id,
      task_id: p.task_id,
      task_title: this.tasks.get(p.task_id)?.title ?? null,
      remaining_seconds: p.remaining_seconds,
      paused_at: new Date(p.pausedAtMs).toISOString(),
      age_ms: nowMs - p.pausedAtMs,
    };
  }
}

/** Pure fold. Applies a copy in recorded-time order, then id. Does not reorder the stored log. */
export function project(events: readonly SessionEvent[]): Projection {
  const p = new Projection();
  for (const e of inFoldOrder(events)) p.apply(e);
  return p;
}

/** Same board for the same events, now, window, and includeStale. Does not read the clock. */
export function foldBoard(events: readonly SessionEvent[], nowMs: number, pausedRollOffMs: number, includeStale: boolean): Board {
  return project(events).board(nowMs, pausedRollOffMs, includeStale);
}

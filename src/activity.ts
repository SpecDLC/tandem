// Running projection of the session log for the activity strip and actor chips.
// It folds each appended event once. It does not keep a second copy of who acted.
import { EVENT_TYPES, inFoldOrder, isActor, type SessionEvent } from "./log.ts";
import { readFocusMinutes } from "./timer.ts";

export type ActorKind = "human" | "agent" | "unknown";

export interface ActorView {
  kind: ActorKind;
  name: string;
}

export interface ActivityItem {
  id: string;
  time: string;
  actor: ActorKind;
  name: string;
  text: string;
  /** Task row to mark, or null when the event changes the focus card. */
  taskId: string | null;
  focus: boolean;
}

/** An actor object shows its name. A missing actor and a string actor read as unknown. The line is not rewritten. */
export function readActor(raw: unknown): ActorView {
  if (isActor(raw)) return { kind: raw.kind, name: raw.name };
  return { kind: "unknown", name: "unknown actor" };
}

/** Relative phrase for an event time. Callers pass a clock truncated to the minute. */
export function relativePhrase(iso: string, nowMs: number): string {
  const delta = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function displayNow(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000;
}

export class ActivityProjection {
  private items: ActivityItem[] = [];
  private titles = new Map<string, string>();
  private who = new Map<string, ActorView>();
  private pomodoros = new Map<string, number>();
  private lengths = new Map<string, number>();
  private runningTitle: string | undefined;
  private starter: ActorView = { kind: "unknown", name: "unknown actor" };

  get length(): number { return this.items.length; }

  clear(): void {
    this.items = [];
    this.titles = new Map();
    this.who = new Map();
    this.pomodoros = new Map();
    this.lengths = new Map();
    this.runningTitle = undefined;
    this.starter = { kind: "unknown", name: "unknown actor" };
  }

  apply(e: SessionEvent): void {
    const actor = readActor(e.actor);
    const data = e.data;
    const taskId = typeof data.task_id === "string" ? data.task_id : null;
    const titled = typeof data.title === "string" ? data.title : undefined;
    if (taskId && titled) this.titles.set(taskId, titled);
    const title = (taskId ? this.titles.get(taskId) : undefined) ?? this.runningTitle;
    const focus = e.type === EVENT_TYPES.pomodoroStarted || e.type === EVENT_TYPES.pomodoroStopped
      || e.type === EVENT_TYPES.pomodoroPaused || e.type === EVENT_TYPES.pomodoroResumed;
    const pomodoroId = typeof data.pomodoro_id === "string" ? data.pomodoro_id : undefined;
    if (e.type === EVENT_TYPES.pomodoroStarted && pomodoroId) this.lengths.set(pomodoroId, readFocusMinutes(data));
    const planned = e.type === EVENT_TYPES.pomodoroFinished && pomodoroId ? (this.lengths.get(pomodoroId) ?? readFocusMinutes(data)) : undefined;
    this.items.push({
      id: e.id,
      time: e.time,
      actor: actor.kind,
      name: actor.name,
      text: sentence(actor.name, e.type, title, planned),
      taskId: focus ? null : taskId,
      focus,
    });
    if (taskId && (e.type === EVENT_TYPES.taskImported || e.type === EVENT_TYPES.taskAdded || e.type === EVENT_TYPES.taskCompleted)) {
      this.who.set(taskId, actor);
    }
    if (e.type === EVENT_TYPES.pomodoroStarted && taskId) {
      this.pomodoros.set(taskId, (this.pomodoros.get(taskId) ?? 0) + 1);
      this.runningTitle = this.titles.get(taskId);
      this.starter = actor;
    }
    if (e.type === EVENT_TYPES.pomodoroStopped || e.type === EVENT_TYPES.pomodoroFinished) this.runningTitle = undefined;
  }

  newest(n: number): ActivityItem[] {
    return this.items.slice(Math.max(0, this.items.length - n)).reverse();
  }

  taskActor(id: string): ActorView { return this.who.get(id) ?? { kind: "unknown", name: "unknown actor" }; }
  pomodoroCount(id: string): number { return this.pomodoros.get(id) ?? 0; }
  focusStarter(): ActorView { return this.starter; }
  /** Planned length of a start, read back for a later finish. Missing minutes read as 25. */
  plannedMinutes(pomodoroId: string): number { return this.lengths.get(pomodoroId) ?? 25; }
}

/** Fold the log in the same recorded-time then id order as the board projection. */
export function foldActivity(events: readonly SessionEvent[]): ActivityProjection {
  const p = new ActivityProjection();
  for (const e of inFoldOrder(events)) p.apply(e);
  return p;
}

function sentence(who: string, type: string, title: string | undefined, minutes?: number): string {
  const named = title ? `“${title}”` : "a task";
  switch (type) {
    case EVENT_TYPES.taskAdded: return `${who} added ${named}`;
    case EVENT_TYPES.taskImported: return `${who} imported ${named}`;
    case EVENT_TYPES.taskCompleted: return `${who} completed ${named}`;
    case EVENT_TYPES.pomodoroStarted: return `${who} started focus on ${named}`;
    case EVENT_TYPES.pomodoroPaused: return `${who} paused the timer`;
    case EVENT_TYPES.pomodoroResumed: return `${who} resumed focus on ${named}`;
    case EVENT_TYPES.pomodoroStopped: return `${who} stopped the timer`;
    case EVENT_TYPES.pomodoroFinished: return `${who} finished a ${minutes ?? 25}-minute focus on ${named}`;
    default: return `${who} updated the board`;
  }
}

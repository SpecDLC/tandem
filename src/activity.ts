// Running projection of the session log for the activity strip and actor chips.
// It folds each appended event once. It does not keep a second copy of who acted.
import { EVENT_TYPES, type SessionEvent } from "./log.ts";

export type ActorLabel = "human" | "agent";

export interface ActivityItem {
  id: string;
  time: string;
  actor: ActorLabel;
  text: string;
  /** Task row to mark, or null when the event changes the focus card. */
  taskId: string | null;
  focus: boolean;
}

export function actorLabel(raw: string | undefined): ActorLabel {
  return raw?.startsWith("agent") ? "agent" : "human";
}

export function actorWord(actor: ActorLabel): "Agent" | "You" {
  return actor === "agent" ? "Agent" : "You";
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
  private who = new Map<string, ActorLabel>();
  private pomodoros = new Map<string, number>();
  private runningTitle: string | undefined;
  private starter: ActorLabel = "human";

  get length(): number { return this.items.length; }

  apply(e: SessionEvent): void {
    const actor = actorLabel(e.actor);
    const data = e.data;
    const taskId = typeof data.task_id === "string" ? data.task_id : null;
    const titled = typeof data.title === "string" ? data.title : undefined;
    if (taskId && titled) this.titles.set(taskId, titled);
    const title = (taskId ? this.titles.get(taskId) : undefined) ?? this.runningTitle;
    const focus = e.type === EVENT_TYPES.pomodoroStarted || e.type === EVENT_TYPES.pomodoroStopped
      || e.type === EVENT_TYPES.pomodoroPaused || e.type === EVENT_TYPES.pomodoroResumed;
    this.items.push({
      id: e.id,
      time: e.time,
      actor,
      text: sentence(actor, e.type, title),
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

  taskActor(id: string): ActorLabel { return this.who.get(id) ?? "human"; }
  pomodoroCount(id: string): number { return this.pomodoros.get(id) ?? 0; }
  focusStarter(): ActorLabel { return this.starter; }
}

function sentence(actor: ActorLabel, type: string, title: string | undefined): string {
  const who = actorWord(actor);
  const named = title ? `“${title}”` : "a task";
  switch (type) {
    case EVENT_TYPES.taskAdded: return `${who} added ${named}`;
    case EVENT_TYPES.taskImported: return `${who} imported ${named}`;
    case EVENT_TYPES.taskCompleted: return `${who} completed ${named}`;
    case EVENT_TYPES.pomodoroStarted: return `${who} started focus on ${named}`;
    case EVENT_TYPES.pomodoroPaused: return `${who} paused the timer`;
    case EVENT_TYPES.pomodoroResumed: return `${who} resumed focus on ${named}`;
    case EVENT_TYPES.pomodoroStopped: return `${who} stopped the timer`;
    case EVENT_TYPES.pomodoroFinished: return `${who} finished focus on ${named}`;
    default: return `${who} updated the board`;
  }
}

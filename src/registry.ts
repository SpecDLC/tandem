// Command registry. One function per command; controls and tools both call through bind().
import {
  DATASCHEMA, EVENT_TYPES, SOURCE, SPECVERSION, compareEvents, createIdMinter, inFoldOrder, isActor, isSessionEvent, serializeEvent,
  type Actor, type EventStore, type SessionEvent,
} from "./log.ts";
import { ActivityProjection } from "./activity.ts";
import { Projection, project, type Status, type TaskView } from "./project.ts";
import {
  BREAK_SECONDS, DEFAULT_FOCUS_MINUTES, MAX_FOCUS_MINUTES, MIN_FOCUS_MINUTES, PAUSED_ROLL_OFF_MS,
  endsAtIso, remainingSeconds,
} from "./timer.ts";

export const COMMAND_NAMES = [
  "import_tasks", "add_task", "complete_task", "list_tasks", "start_pomodoro",
  "pause_pomodoro", "resume_pomodoro", "stop_pomodoro", "get_status", "export_events", "import_events",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export type { Actor };
export { isActor };

export type Rejected = { ok: false; code: string };
export type Row = { path: string; code: string };
const reject = (code: string): Rejected => ({ ok: false, code });

export const TASKS_SCHEMA = "tandem.tasks/v0";
const KNOWN_TASK_FIELDS = new Set(["id", "title", "estimate_pomodoros", "notes"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class Session {
  private events: SessionEvent[] = [];
  private proj = new Projection();
  /** Activity strip and actor chips. Folded as each event is appended, including the load. */
  readonly activity = new ActivityProjection();
  /** Events appended since the page last painted. Load does not fill this. */
  private appended: SessionEvent[] = [];
  private ids = createIdMinter();
  private queue: Promise<unknown> = Promise.resolve();
  private store: EventStore;
  private now: () => number;

  constructor(store: EventStore, now: () => number = Date.now) { this.store = store; this.now = now; }

  static async open(store: EventStore, now?: () => number): Promise<Session> {
    const s = new Session(store, now);
    for (const line of await store.load()) s.events.push(JSON.parse(line) as SessionEvent);
    s.reproject();
    return s;
  }

  /** Commands run one at a time, so a check and its append never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private mint(type: string, subject: string, actor: SessionEvent["actor"], data: Record<string, unknown>, timeMs = this.now()): SessionEvent {
    return {
      specversion: SPECVERSION, id: this.ids(timeMs), source: SOURCE, type, subject,
      time: new Date(timeMs).toISOString(), datacontenttype: "application/json", dataschema: DATASCHEMA,
      ...(actor !== undefined ? { actor } : {}),
      data,
    };
  }

  /** Append-order tail. Empty log cursor is "". This is not the latest id by recorded time. */
  private tail(): string {
    return this.events.at(-1)?.id ?? "";
  }

  /** When the agent sent expected_cursor and it is not the tail, append nothing. Absent keeps today's command. */
  private stale(expected: unknown): Rejected | undefined {
    if (expected === undefined) return;
    if (expected !== this.tail()) return reject("stale_cursor");
  }

  /** Board and activity follow recorded time, then id. The stored lines stay in append order. */
  private reproject(): void {
    const ordered = inFoldOrder(this.events);
    this.proj = new Projection();
    this.activity.clear();
    for (const e of ordered) {
      this.proj.apply(e);
      this.activity.apply(e);
    }
  }

  private async append(batch: SessionEvent[]): Promise<void> {
    if (batch.length === 0) return;
    await this.store.append(batch.map(serializeEvent));
    for (const e of batch) {
      this.events.push(e);
      this.appended.push(e);
    }
    this.reproject();
  }

  /** Events appended since the last take. The page paints from `activity` and uses this only to mark a fresh agent change. */
  takeAppended(): SessionEvent[] {
    const batch = this.appended;
    this.appended = [];
    return batch;
  }

  private taskData(id: string, title: string, estimate?: number, notes?: string): Record<string, unknown> {
    const d: Record<string, unknown> = { task_id: id, title };
    if (estimate !== undefined) d.estimate_pomodoros = estimate;
    if (notes !== undefined) d.notes = notes;
    return d;
  }

  /** Internal timer step: records pomodoro_finished once the scheduled end is reached. Not a command. */
  finishPomodoro(): Promise<{ ok: true; pomodoro_id: string } | Rejected> {
    return this.serial(async () => {
      const r = this.proj.running;
      if (!r) return reject("no_running_pomodoro");
      if (this.now() < r.endsAtMs) return reject("pomodoro_not_finished");
      await this.append([this.mint(EVENT_TYPES.pomodoroFinished, r.pomodoro_id, r.actor,
        { pomodoro_id: r.pomodoro_id, task_id: r.task_id }, r.endsAtMs)]);
      return { ok: true as const, pomodoro_id: r.pomodoro_id };
    });
  }

  private async tick(): Promise<void> {
    const r = this.proj.running;
    if (r && this.now() >= r.endsAtMs) {
      await this.append([this.mint(EVENT_TYPES.pomodoroFinished, r.pomodoro_id, r.actor,
        { pomodoro_id: r.pomodoro_id, task_id: r.task_id }, r.endsAtMs)]);
    }
  }

  importTasks(actor: Actor, payload: unknown) {
    return this.serial(async () => {
      if (!isObject(payload)) return reject("invalid_payload");
      const stale = this.stale(payload.expected_cursor);
      if (stale) return stale;
      if (payload.schema !== TASKS_SCHEMA) return reject("unsupported_schema");
      if (!Array.isArray(payload.tasks)) return reject("invalid_payload");
      const accepted: string[] = [];
      const rejected: Row[] = [];
      const skipped: { id: string; code: string }[] = [];
      const ignored: { path: string }[] = [];
      const seen = new Set<string>();
      const batch: SessionEvent[] = [];
      payload.tasks.forEach((row: unknown, i: number) => {
        const path = `tasks[${i}]`;
        if (!isObject(row)) { rejected.push({ path, code: "invalid_payload" }); return; }
        for (const k of Object.keys(row)) if (!KNOWN_TASK_FIELDS.has(k)) ignored.push({ path: `${path}.${k}` });
        if (typeof row.title !== "string" || row.title.trim() === "") { rejected.push({ path: `${path}.title`, code: "missing_title" }); return; }
        if (row.id !== undefined && !(typeof row.id === "string" && row.id !== "")) { rejected.push({ path: `${path}.id`, code: "invalid_payload" }); return; }
        if (row.estimate_pomodoros !== undefined && !(Number.isInteger(row.estimate_pomodoros) && (row.estimate_pomodoros as number) >= 0)) {
          rejected.push({ path: `${path}.estimate_pomodoros`, code: "invalid_payload" }); return;
        }
        if (row.notes !== undefined && typeof row.notes !== "string") { rejected.push({ path: `${path}.notes`, code: "invalid_payload" }); return; }
        const id = row.id ?? this.ids(this.now());
        if (this.proj.hasTask(id) || seen.has(id)) { skipped.push({ id, code: "duplicate_id" }); return; }
        seen.add(id);
        accepted.push(id);
        batch.push(this.mint(EVENT_TYPES.taskImported, id, actor,
          this.taskData(id, row.title, row.estimate_pomodoros as number | undefined, row.notes as string | undefined)));
      });
      await this.append(batch);
      return { ok: true as const, accepted: accepted.length, task_ids: accepted, rejected, skipped, ignored_fields: ignored };
    });
  }

  addTask(actor: Actor, title: unknown, estimate?: unknown, expectedCursor?: unknown) {
    return this.serial(async () => {
      const stale = this.stale(expectedCursor);
      if (stale) return stale;
      if (typeof title !== "string" || title.trim() === "") return reject("missing_title");
      if (estimate !== undefined && !(Number.isInteger(estimate) && (estimate as number) >= 0)) return reject("invalid_payload");
      const id = this.ids(this.now());
      await this.append([this.mint(EVENT_TYPES.taskAdded, id, actor, this.taskData(id, title, estimate as number | undefined))]);
      return { ok: true as const, task_id: id };
    });
  }

  completeTask(actor: Actor, taskId: unknown, expectedCursor?: unknown) {
    return this.serial(async () => {
      const stale = this.stale(expectedCursor);
      if (stale) return stale;
      const t = typeof taskId === "string" ? this.proj.task(taskId) : undefined;
      if (!t) return reject("unknown_task");
      if (t.status === "completed") return reject("task_not_open");
      await this.append([this.mint(EVENT_TYPES.taskCompleted, t.task_id, actor, { task_id: t.task_id })]);
      return { ok: true as const, task_id: t.task_id };
    });
  }

  listTasks(status?: unknown): { ok: true; tasks: TaskView[] } | Rejected {
    if (status !== undefined && status !== "open" && status !== "completed") return reject("invalid_payload");
    return { ok: true, tasks: this.proj.list(status as "open" | "completed" | undefined) };
  }

  startPomodoro(actor: Actor, taskId: unknown, minutes?: unknown, expectedCursor?: unknown) {
    return this.serial(async () => {
      const stale = this.stale(expectedCursor);
      if (stale) return stale;
      await this.tick();
      const length = resolveMinutes(minutes);
      if (typeof length !== "number") return length;
      const t = typeof taskId === "string" ? this.proj.task(taskId) : undefined;
      if (!t) return reject("unknown_task");
      if (t.status === "completed") return reject("task_not_open");
      if (this.proj.running || this.proj.inWindowPaused(this.now(), PAUSED_ROLL_OFF_MS).length > 0) return reject("pomodoro_already_running");
      const at = this.now();
      const pid = this.ids(at);
      const focus_seconds = length * 60;
      const ends_at = endsAtIso(at, focus_seconds);
      await this.append([this.mint(EVENT_TYPES.pomodoroStarted, pid, actor, {
        pomodoro_id: pid, task_id: t.task_id, focus_seconds, break_seconds: BREAK_SECONDS, ends_at, minutes: length,
      }, at)]);
      return { ok: true as const, pomodoro_id: pid, task_id: t.task_id, ends_at, minutes: length };
    });
  }

  pausePomodoro(actor: Actor, expectedCursor?: unknown) {
    return this.serial(async () => {
      const stale = this.stale(expectedCursor);
      if (stale) return stale;
      await this.tick();
      const r = this.proj.running;
      if (!r) return reject("no_running_pomodoro");
      const at = this.now();
      const remaining_seconds = remainingSeconds(r.endsAtMs, at);
      await this.append([this.mint(EVENT_TYPES.pomodoroPaused, r.pomodoro_id, actor, {
        pomodoro_id: r.pomodoro_id, remaining_seconds,
      }, at)]);
      return { ok: true as const, pomodoro_id: r.pomodoro_id, remaining_seconds };
    });
  }

  resumePomodoro(actor: Actor, pomodoroId: unknown, expectedCursor?: unknown) {
    return this.serial(async () => {
      const stale = this.stale(expectedCursor);
      if (stale) return stale;
      await this.tick();
      if (typeof pomodoroId !== "string" || pomodoroId === "") return reject("invalid_payload");
      const held = this.proj.findPaused(pomodoroId);
      if (!held) return reject("no_paused_pomodoro");
      const at = this.now();
      if (this.proj.running || this.proj.inWindowPaused(at, PAUSED_ROLL_OFF_MS).some((p) => p.pomodoro_id !== held.pomodoro_id)) {
        return reject("pomodoro_already_running");
      }
      const ends_at = new Date(at + held.remaining_seconds * 1000).toISOString();
      await this.append([this.mint(EVENT_TYPES.pomodoroResumed, held.pomodoro_id, actor, {
        pomodoro_id: held.pomodoro_id, ends_at,
      }, at)]);
      return { ok: true as const, pomodoro_id: held.pomodoro_id, ends_at };
    });
  }

  stopPomodoro(actor: Actor, pomodoroId?: unknown, expectedCursor?: unknown) {
    return this.serial(async () => {
      const stale = this.stale(expectedCursor);
      if (stale) return stale;
      await this.tick();
      if (pomodoroId !== undefined) {
        if (typeof pomodoroId !== "string" || pomodoroId === "") return reject("invalid_payload");
        const running = this.proj.running;
        const held = this.proj.findPaused(pomodoroId);
        const target = running?.pomodoro_id === pomodoroId ? running.pomodoro_id : held?.pomodoro_id;
        if (!target) return reject("no_running_pomodoro");
        await this.append([this.mint(EVENT_TYPES.pomodoroStopped, target, actor, { pomodoro_id: target })]);
        return { ok: true as const, pomodoro_id: target };
      }
      const r = this.proj.running ?? this.proj.inWindowPaused(this.now(), PAUSED_ROLL_OFF_MS)[0];
      if (!r) return reject("no_running_pomodoro");
      await this.append([this.mint(EVENT_TYPES.pomodoroStopped, r.pomodoro_id, actor, { pomodoro_id: r.pomodoro_id })]);
      return { ok: true as const, pomodoro_id: r.pomodoro_id };
    });
  }

  getStatus(): { ok: true } & Status {
    return { ok: true, ...this.proj.status(this.now()) };
  }

  /** Screen projection. `includeStale` only changes the read; it does not append an event. */
  screenBoard(includeStale: boolean): { ok: true } & Status {
    return { ok: true, ...this.proj.board(this.now(), PAUSED_ROLL_OFF_MS, includeStale) };
  }

  /** Walks append order, never ULID magnitude. */
  exportEvents(sinceCursor?: unknown): { ok: true; events: SessionEvent[]; cursor: string } | (Rejected & { events: []; cursor: string }) {
    if (sinceCursor !== undefined && typeof sinceCursor !== "string") return { ...reject("unknown_cursor"), events: [], cursor: "" };
    let from = 0;
    if (sinceCursor) {
      const at = this.events.findIndex((e) => e.id === sinceCursor);
      if (at < 0) return { ...reject("unknown_cursor"), events: [], cursor: sinceCursor };
      from = at + 1;
    }
    const events = this.events.slice(from);
    return { ok: true, events, cursor: this.events.at(-1)?.id ?? "" };
  }

  /**
   * Appends each event unchanged, ids and actors included. Does not re-run command rules.
   * One event that fails the structural check rejects the file and appends nothing.
   */
  importEvents(incoming: unknown, expectedCursor?: unknown) {
    return this.serial(async () => {
      const stale = this.stale(expectedCursor);
      if (stale) return stale;
      if (!Array.isArray(incoming)) return reject("invalid_events");
      if (incoming.some((e) => !isSessionEvent(e))) return reject("invalid_events");
      const have = new Set(this.events.map((e) => e.id));
      const batch: SessionEvent[] = [];
      const skipped: { id: string; code: string }[] = [];
      for (const e of incoming) {
        if (!isSessionEvent(e)) return reject("invalid_events");
        if (have.has(e.id)) { skipped.push({ id: e.id, code: "duplicate_id" }); continue; }
        have.add(e.id);
        batch.push(e);
      }
      batch.sort(compareEvents);
      await this.append(batch);
      return { ok: true as const, imported: batch.length, rejected: [] as Row[], skipped };
    });
  }

  /** The pure fold over the whole log, for comparison against the live projection. */
  replayProjection(): Projection { return project(this.events); }

  /** Append-order log already in memory. The screen uses this for conflict marks. It does not export a file. */
  logEvents(): readonly SessionEvent[] { return this.events; }
}

function resolveMinutes(input: unknown): number | Rejected {
  if (input === undefined) return DEFAULT_FOCUS_MINUTES;
  if (typeof input !== "number" || !Number.isInteger(input) || input < MIN_FOCUS_MINUTES || input > MAX_FOCUS_MINUTES) {
    return reject("invalid_payload");
  }
  return input;
}

/** The one command set. A control and a tool both get these. The actor object is the only difference. */
export function bind(session: Session, actor: Actor) {
  return {
    import_tasks: (payload: unknown) => session.importTasks(actor, payload),
    add_task: (title: unknown, estimate?: unknown, expected_cursor?: unknown) => session.addTask(actor, title, estimate, expected_cursor),
    complete_task: (task_id: unknown, expected_cursor?: unknown) => session.completeTask(actor, task_id, expected_cursor),
    list_tasks: (status?: unknown) => session.listTasks(status),
    start_pomodoro: (task_id: unknown, minutes?: unknown, expected_cursor?: unknown) => session.startPomodoro(actor, task_id, minutes, expected_cursor),
    pause_pomodoro: (expected_cursor?: unknown) => session.pausePomodoro(actor, expected_cursor),
    resume_pomodoro: (pomodoro_id: unknown, expected_cursor?: unknown) => session.resumePomodoro(actor, pomodoro_id, expected_cursor),
    stop_pomodoro: (pomodoro_id?: unknown, expected_cursor?: unknown) => session.stopPomodoro(actor, pomodoro_id, expected_cursor),
    get_status: () => session.getStatus(),
    export_events: (since_cursor?: unknown) => session.exportEvents(since_cursor),
    import_events: (events: unknown, expected_cursor?: unknown) => session.importEvents(events, expected_cursor),
  } satisfies Record<CommandName, (...a: never[]) => unknown>;
}

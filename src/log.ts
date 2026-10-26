// Session log: CloudEvents 1.0 structured JSON, one event per line, append only.
import { monotonicFactory } from "ulid";

export const SOURCE = "urn:specdlc:tandem";
export const SPECVERSION = "1.0";
export const DATASCHEMA = "urn:specdlc:schema:tandem.session:1";
const TYPE_PREFIX = "com.specdlc.tandem.";

export const EVENT_TYPES = {
  taskImported: `${TYPE_PREFIX}task_imported.v1`,
  taskAdded: `${TYPE_PREFIX}task_added.v1`,
  taskCompleted: `${TYPE_PREFIX}task_completed.v1`,
  pomodoroStarted: `${TYPE_PREFIX}pomodoro_started.v1`,
  pomodoroPaused: `${TYPE_PREFIX}pomodoro_paused.v1`,
  pomodoroResumed: `${TYPE_PREFIX}pomodoro_resumed.v1`,
  pomodoroStopped: `${TYPE_PREFIX}pomodoro_stopped.v1`,
  pomodoroFinished: `${TYPE_PREFIX}pomodoro_finished.v1`,
} as const;
const KNOWN_TYPES: ReadonlySet<string> = new Set(Object.values(EVENT_TYPES));

/** Who did a command. New events store this object. Old lines keep a string, or no actor at all. */
export interface Actor {
  kind: "human" | "agent";
  name: string;
}

export interface SessionEvent {
  specversion: typeof SPECVERSION;
  id: string;
  source: typeof SOURCE;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  dataschema: string;
  /** Object on a new event. A string, or absent, on a line written before this version. */
  actor?: Actor | string;
  data: Record<string, unknown>;
}

export function isActor(v: unknown): v is Actor {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const a = v as Record<string, unknown>;
  return (a.kind === "human" || a.kind === "agent") && typeof a.name === "string" && a.name.trim() !== "";
}

// Reference export key order: core attributes, then actor, then data.
const CORE_ORDER = ["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema", "actor"];

export function serializeEvent(e: object): string {
  const rec = e as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CORE_ORDER) if (k in rec) out[k] = rec[k];
  for (const k of Object.keys(rec)) if (!(k in out) && k !== "data") out[k] = rec[k];
  if ("data" in rec) out.data = rec.data;
  return JSON.stringify(out);
}

export function toJsonl(events: readonly object[]): string {
  return events.map((e) => `${serializeEvent(e)}\n`).join("");
}

export function parseJsonl(text: string): unknown[] {
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as unknown);
}

/** First line of an exported log file. A file from before this version has no header. */
export const LOG_FORMAT = "tandem.session-log";
export const LOG_VERSION = 1;

export function formatLogFile(events: readonly object[]): string {
  const header = JSON.stringify({ format: LOG_FORMAT, version: LOG_VERSION });
  const body = toJsonl(events);
  return `${header}\n${body}`;
}

function isHeader(v: unknown): v is { format: string; version: number } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.format === "string" && typeof o.version === "number" && o.specversion === undefined;
}

/** Read a log file. A bad line rejects the file. Nothing here sends the file anywhere. */
export function parseLogFile(text: string): { ok: true; events: unknown[] } | { ok: false; code: "invalid_events" } {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: true, events: [] };
  const head = lines[0];
  if (head === undefined) return { ok: false, code: "invalid_events" };
  let first: unknown;
  try { first = JSON.parse(head) as unknown; } catch { return { ok: false, code: "invalid_events" }; }
  let start = 0;
  if (isHeader(first)) {
    if (first.format !== LOG_FORMAT || first.version !== LOG_VERSION) return { ok: false, code: "invalid_events" };
    start = 1;
  }
  const events: unknown[] = [];
  for (const line of lines.slice(start)) {
    try { events.push(JSON.parse(line) as unknown); } catch { return { ok: false, code: "invalid_events" }; }
  }
  if (events.some((e) => !isSessionEvent(e))) return { ok: false, code: "invalid_events" };
  return { ok: true, events };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A missing actor and a string actor are old lines. An actor object must name a human or an agent. */
function actorOk(e: Record<string, unknown>): boolean {
  if (!("actor" in e) || e.actor === undefined) return true;
  if (typeof e.actor === "string") return true;
  return isActor(e.actor);
}

/** Minutes, when present, are the resolved focus length. Absence is an old line and stays valid. */
function minutesOk(data: Record<string, unknown>): boolean {
  if (!("minutes" in data)) return true;
  const m = data.minutes;
  return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 180;
}

// Structural check for import. It does not re-run command rejection rules.
// A file that holds one failing event is rejected as a whole by the caller.
export function isSessionEvent(v: unknown): v is SessionEvent {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  const data = e.data;
  return (
    e.specversion === SPECVERSION && nonEmpty(e.id) && e.source === SOURCE &&
    typeof e.type === "string" && KNOWN_TYPES.has(e.type) &&
    nonEmpty(e.subject) && typeof e.time === "string" && ISO_UTC.test(e.time) && !Number.isNaN(Date.parse(e.time)) &&
    actorOk(e) &&
    typeof data === "object" && data !== null && !Array.isArray(data) && minutesOk(data as Record<string, unknown>)
  );
}

// ULID minting. The factory is monotonic within one millisecond.
export function createIdMinter(): (timeMs: number) => string {
  const next = monotonicFactory();
  return (timeMs) => next(timeMs);
}

/**
 * Fold order is the recorded `time` instant, then `id`.
 * The clock embedded in a ULID is not an ordering key.
 */
export function compareEvents(a: { time: string; id: string }, b: { time: string; id: string }): number {
  const dt = Date.parse(a.time) - Date.parse(b.time);
  if (dt < 0) return -1;
  if (dt > 0) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function inFoldOrder<T extends { time: string; id: string }>(events: readonly T[]): T[] {
  return [...events].sort(compareEvents);
}

// The working copy. Holds serialized lines in append order and never rewrites one.
export interface EventStore {
  load(): Promise<string[]>;
  append(lines: readonly string[]): Promise<void>;
}

export class MemoryStore implements EventStore {
  private lines: string[] = [];
  async load(): Promise<string[]> { return [...this.lines]; }
  async append(lines: readonly string[]): Promise<void> { this.lines.push(...lines); }
}

// IndexedDB working copy (REQ-BROWSER-IDB). Keys are auto-increment, so cursor order is append order.
export class IdbStore implements EventStore {
  private db: Promise<IDBDatabase> | undefined;
  private readonly name: string;
  constructor(name = "tandem") { this.name = name; }
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("events", { autoIncrement: true }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }
  async load(): Promise<string[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("events").objectStore("events").getAll();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
  }
  async append(lines: readonly string[]): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readwrite");
      const store = tx.objectStore("events");
      for (const l of lines) store.add(l);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

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

export interface SessionEvent {
  specversion: typeof SPECVERSION;
  id: string;
  source: typeof SOURCE;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  dataschema: string;
  actor: string;
  data: Record<string, unknown>;
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

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Structural check for import_events: a CloudEvents 1.0 object in this profile's core.
// It does not re-run command rejection rules.
export function isSessionEvent(v: unknown): v is SessionEvent {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  const data = e.data;
  return (
    e.specversion === SPECVERSION && nonEmpty(e.id) && e.source === SOURCE &&
    typeof e.type === "string" && KNOWN_TYPES.has(e.type) &&
    nonEmpty(e.subject) && typeof e.time === "string" && ISO_UTC.test(e.time) && !Number.isNaN(Date.parse(e.time)) &&
    nonEmpty(e.actor) && /^(human|agent):/.test(e.actor) &&
    typeof data === "object" && data !== null && !Array.isArray(data)
  );
}

// ULID minting. The factory is monotonic within one millisecond.
export function createIdMinter(): (timeMs: number) => string {
  const next = monotonicFactory();
  return (timeMs) => next(timeMs);
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

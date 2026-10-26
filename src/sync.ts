// Page sync against one user-owned endpoint. The local log stays authoritative.
// Settings live in their own IndexedDB database, not in the event log and not in localStorage.
import { readActor } from "./activity.ts";
import { EVENT_TYPES, isSessionEvent, type EventStore, type SessionEvent } from "./log.ts";
import type { Session } from "./registry.ts";

export const NEWER_VERSION = "This endpoint speaks a newer sync version.";
export const SYNC_BUSY = "sync busy";
const PAGE_LIMIT = 100;
const MAX_PUSH = 5;

export function invalidSeqMessage(seq: number): string {
  return `Sync stopped at seq ${seq}.`;
}

export interface SyncSettings {
  endpoint: string;
  token: string;
  lastSeq: number;
  /** Event ids this browser has already seen on the endpoint. */
  knownIds: string[];
}

export interface ConflictSide {
  actor: string;
  time: string;
}

export interface Conflict {
  taskId: string;
  sides: ConflictSide[];
}

export interface SyncSettingsStore {
  load(): Promise<SyncSettings | null>;
  save(settings: SyncSettings): Promise<void>;
  /** Clears the endpoint and the token. Leaves lastSeq, known ids, conflicts, and the event log. */
  turnOff(): Promise<void>;
  loadConflicts(): Promise<Conflict[]>;
  saveConflicts(conflicts: Conflict[]): Promise<void>;
}

export class MemorySyncSettings implements SyncSettingsStore {
  private value: SyncSettings | null = null;
  private conflicts: Conflict[] = [];
  async load(): Promise<SyncSettings | null> {
    return this.value ? { ...this.value, knownIds: [...this.value.knownIds] } : null;
  }
  async save(settings: SyncSettings): Promise<void> {
    this.value = { ...settings, knownIds: [...settings.knownIds] };
  }
  async turnOff(): Promise<void> {
    if (!this.value) return;
    this.value = { ...this.value, endpoint: "", token: "" };
  }
  async loadConflicts(): Promise<Conflict[]> { return this.conflicts.map((c) => ({ ...c, sides: c.sides.map((s) => ({ ...s })) })); }
  async saveConflicts(conflicts: Conflict[]): Promise<void> { this.conflicts = conflicts.map((c) => ({ ...c, sides: c.sides.map((s) => ({ ...s })) })); }
}

export class IdbSyncSettings implements SyncSettingsStore {
  private db: Promise<IDBDatabase> | undefined;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("tandem-sync", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
        if (!db.objectStoreNames.contains("conflicts")) db.createObjectStore("conflicts");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }
  private async request<T>(mode: IDBTransactionMode, store: "settings" | "conflicts", run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = run(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async load(): Promise<SyncSettings | null> {
    const row = await this.request<SyncSettings | undefined>("readonly", "settings", (s) => s.get("current"));
    if (!row) return null;
    return { endpoint: row.endpoint, token: row.token, lastSeq: row.lastSeq, knownIds: [...(row.knownIds ?? [])] };
  }
  async save(settings: SyncSettings): Promise<void> {
    await this.request("readwrite", "settings", (s) => s.put(settings, "current"));
  }
  async turnOff(): Promise<void> {
    const current = await this.load();
    if (!current) return;
    await this.save({ ...current, endpoint: "", token: "" });
  }
  async loadConflicts(): Promise<Conflict[]> {
    const row = await this.request<Conflict[] | undefined>("readonly", "conflicts", (s) => s.get("current"));
    return row ?? [];
  }
  async saveConflicts(conflicts: Conflict[]): Promise<void> {
    await this.request("readwrite", "conflicts", (s) => s.put(conflicts, "current"));
  }
}

export function endpointOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Authorization is attached only for the configured origin, and only when a token is set. */
export function syncHeaders(target: string, endpoint: string, token: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const trimmed = token.trim();
  const targetOrigin = endpointOrigin(target);
  if (trimmed && targetOrigin && targetOrigin === endpointOrigin(endpoint)) headers.authorization = `Bearer ${trimmed}`;
  return headers;
}

/** connect-src allows this page and, when set, the one configured origin. */
export function applyConnectCsp(endpoint: string): void {
  if (typeof document === "undefined") return;
  const origin = endpoint ? endpointOrigin(endpoint) : null;
  const connect = origin ? `'self' ${origin}` : `'self'`;
  let meta = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    document.head.insertBefore(meta, document.head.firstChild);
  }
  meta.content = `connect-src ${connect}`;
}

export function conflictLabel(conflict: Conflict): string {
  return `Conflict · ${conflict.sides.map((s) => `${s.actor} · ${s.time}`).join(" · ")}`;
}

export function mergeConflicts(...groups: readonly (readonly Conflict[])[]): Conflict[] {
  const map = new Map<string, Conflict>();
  for (const group of groups) for (const conflict of group) if (!map.has(conflict.taskId)) map.set(conflict.taskId, conflict);
  return [...map.values()];
}

function taskIdOf(event: SessionEvent): string | null {
  const id = event.data.task_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function sideOf(event: SessionEvent): ConflictSide {
  return { actor: readActor(event.actor).name, time: event.time };
}

/** Two completions, or a start that lands after a completion. Both are visible from the log alone. */
export function findConflicts(events: readonly SessionEvent[]): Conflict[] {
  const completes = new Map<string, SessionEvent[]>();
  const starts = new Map<string, SessionEvent[]>();
  for (const event of events) {
    const taskId = taskIdOf(event);
    if (!taskId) continue;
    const bucket = event.type === EVENT_TYPES.taskCompleted ? completes : event.type === EVENT_TYPES.pomodoroStarted ? starts : null;
    if (!bucket) continue;
    const list = bucket.get(taskId) ?? [];
    list.push(event);
    bucket.set(taskId, list);
  }
  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (const [taskId, list] of completes) {
    if (list.length < 2) continue;
    seen.add(taskId);
    out.push({ taskId, sides: list.map(sideOf) });
  }
  for (const [taskId, list] of starts) {
    if (seen.has(taskId)) continue;
    const done = completes.get(taskId) ?? [];
    const first = done[0];
    if (!first) continue;
    const earliest = Math.min(...done.map((event) => Date.parse(event.time)));
    const late = list.find((event) => Date.parse(event.time) > earliest);
    if (!late) continue;
    out.push({ taskId, sides: [sideOf(first), sideOf(late)] });
  }
  return out;
}

/**
 * A start and a completion that arrived from different sides while apart.
 * A start already acknowledged by the endpoint is not treated as unsent.
 */
export function crossConflicts(
  localBefore: readonly SessionEvent[],
  remoteNew: readonly SessionEvent[],
  unackedIds: ReadonlySet<string>,
): Conflict[] {
  const out: Conflict[] = [];
  const tasks = new Set<string>();
  for (const event of [...localBefore, ...remoteNew]) {
    const taskId = taskIdOf(event);
    if (taskId && (event.type === EVENT_TYPES.pomodoroStarted || event.type === EVENT_TYPES.taskCompleted)) tasks.add(taskId);
  }
  for (const taskId of tasks) {
    const localStarts = localBefore.filter((event) => event.type === EVENT_TYPES.pomodoroStarted && taskIdOf(event) === taskId);
    const localCompletes = localBefore.filter((event) => event.type === EVENT_TYPES.taskCompleted && taskIdOf(event) === taskId);
    const remoteStarts = remoteNew.filter((event) => event.type === EVENT_TYPES.pomodoroStarted && taskIdOf(event) === taskId);
    const remoteCompletes = remoteNew.filter((event) => event.type === EVENT_TYPES.taskCompleted && taskIdOf(event) === taskId);
    const startAfterTheirs = remoteStarts.length > 0 && localCompletes.length > 0;
    const unackedStart = localStarts.find((event) => unackedIds.has(event.id));
    const completeAfterTheirs = remoteCompletes.length > 0 && unackedStart !== undefined;
    if (!startAfterTheirs && !completeAfterTheirs) continue;
    const start = remoteStarts[0] ?? unackedStart;
    const complete = localCompletes[0] ?? remoteCompletes[0];
    if (!start || !complete) continue;
    out.push({ taskId, sides: [sideOf(start), sideOf(complete)] });
  }
  return out;
}

export type SyncReport = {
  ok: boolean;
  code: "ok" | "off" | "unreachable" | "newer_version" | "invalid_events" | "sync_busy" | "unauthorized" | "bad_endpoint";
  message: string;
  lastSeq: number;
  seq?: number;
};

interface EventRow { seq: number; event: unknown }
interface EventsBody { version?: unknown; events?: EventRow[]; next_seq?: unknown; more?: unknown }

function parseLine(line: string): SessionEvent {
  return JSON.parse(line) as SessionEvent;
}

/**
 * Catch up, then push local events the endpoint has not returned.
 * A 409 reads again and retries. The fifth failure reports sync busy.
 * `beforePush` runs after the read and before the post, so a test can interleave another writer.
 */
export async function syncSession(opts: {
  session: Session;
  store: EventStore;
  settings: SyncSettingsStore;
  fetchImpl?: typeof fetch;
  beforePush?: () => Promise<void>;
}): Promise<SyncReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const saved = await opts.settings.load();
  const lastSeqStart = saved?.lastSeq ?? 0;
  if (!saved || saved.endpoint.trim() === "") return { ok: false, code: "off", message: "Sync is off.", lastSeq: lastSeqStart };
  const endpoint = saved.endpoint.replace(/\/$/, "");
  if (!endpointOrigin(endpoint)) return { ok: false, code: "bad_endpoint", message: "That endpoint URL is not valid.", lastSeq: saved.lastSeq };
  const token = saved.token;
  let lastSeq = saved.lastSeq;
  const known = new Set(saved.knownIds);
  const initial = await opts.store.load();
  const unacked = new Set(initial.map(parseLine).filter((event) => !known.has(event.id)).map((event) => event.id));
  const crossed: Conflict[] = [];

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = endpoint + path;
    const headers = { ...syncHeaders(url, endpoint, token), ...(init?.headers as Record<string, string> | undefined) };
    return fetchImpl(url, { ...init, headers, redirect: "error" });
  };

  const fail = (code: SyncReport["code"], message: string, seq?: number): SyncReport =>
    ({ ok: false, code, message, lastSeq, ...(seq !== undefined ? { seq } : {}) });

  const persist = () => opts.settings.save({ endpoint, token, lastSeq, knownIds: [...known] });

  const remember = async (remoteNew: SessionEvent[]) => {
    const lines = await opts.store.load();
    const events = lines.map(parseLine);
    const conflicts = mergeConflicts(findConflicts(events), crossed, crossConflicts(events, remoteNew, unacked), await opts.settings.loadConflicts());
    await opts.settings.saveConflicts(conflicts);
  };

  let infoNext = lastSeq + 1;
  try {
    const infoRes = await request("/v1/info");
    if (infoRes.status === 404) return fail("newer_version", NEWER_VERSION);
    if (infoRes.status === 401 || infoRes.status === 403) return fail("unauthorized", "The endpoint refused the token.");
    if (!infoRes.ok) return fail("unreachable", "The endpoint is unreachable.");
    const info = await infoRes.json() as { version?: unknown; next_seq?: unknown };
    if (info.version !== 1) return fail("newer_version", NEWER_VERSION);
    if (typeof info.next_seq === "number") infoNext = info.next_seq;
  } catch {
    return fail("unreachable", "The endpoint is unreachable.");
  }

  const catchUp = async (): Promise<{ ok: true; nextSeq: number } | SyncReport> => {
    let nextSeq = infoNext;
    for (;;) {
      let res: Response;
      try { res = await request(`/v1/events?since=${lastSeq}&limit=${PAGE_LIMIT}`); }
      catch { return fail("unreachable", "The endpoint is unreachable."); }
      if (res.status === 404) return fail("newer_version", NEWER_VERSION);
      if (res.status === 401 || res.status === 403) return fail("unauthorized", "The endpoint refused the token.");
      if (!res.ok) return fail("unreachable", "The endpoint is unreachable.");
      const body = await res.json() as EventsBody;
      if (body.version !== undefined && body.version !== 1) return fail("newer_version", NEWER_VERSION);
      if (typeof body.next_seq === "number") nextSeq = body.next_seq;
      const rows = Array.isArray(body.events) ? body.events : [];
      const bad = rows.find((row) => !isSessionEvent(row.event));
      if (bad) return fail("invalid_events", invalidSeqMessage(bad.seq), bad.seq);
      const beforeLines = await opts.store.load();
      const before = new Set(beforeLines.map((line) => parseLine(line).id));
      const seqBefore = lastSeq;
      if (rows.length > 0) {
        const incoming = rows.map((row) => row.event);
        const imported = await opts.session.importEvents(incoming);
        if (!imported.ok) {
          const first = rows[0];
          return fail("invalid_events", invalidSeqMessage(first ? first.seq : lastSeq), first?.seq);
        }
        for (const row of rows) {
          if (!isSessionEvent(row.event)) continue;
          known.add(row.event.id);
          if (typeof row.seq === "number" && row.seq > lastSeq) lastSeq = row.seq;
        }
        await persist();
      }
      const remoteNew = rows.flatMap((row) => isSessionEvent(row.event) && !before.has(row.event.id) ? [row.event] : []);
      const localBefore = beforeLines.map(parseLine);
      crossed.push(...crossConflicts(localBefore, remoteNew, unacked));
      await remember([]);
      if (body.more === true && rows.length > 0 && lastSeq === seqBefore) return fail("unreachable", "The endpoint is unreachable.");
      if (body.more !== true || rows.length === 0) return { ok: true, nextSeq };
    }
  };

  for (let attempt = 1; attempt <= MAX_PUSH; attempt++) {
    const caught = await catchUp();
    if (!("nextSeq" in caught)) return caught;
    const pending = (await opts.store.load()).map(parseLine).filter((event) => !known.has(event.id));
    if (pending.length === 0) {
      await remember([]);
      await persist();
      return { ok: true, code: "ok", message: "Synced.", lastSeq };
    }
    if (opts.beforePush) await opts.beforePush();
    let res: Response;
    try {
      res = await request("/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_next_seq: caught.nextSeq, events: pending }),
      });
    } catch {
      return fail("unreachable", "The endpoint is unreachable.");
    }
    if (res.status === 409) {
      if (attempt === MAX_PUSH) return fail("sync_busy", SYNC_BUSY);
      continue;
    }
    if (res.status === 404) return fail("newer_version", NEWER_VERSION);
    if (res.status === 401 || res.status === 403) return fail("unauthorized", "The endpoint refused the token.");
    if (!res.ok) return fail("unreachable", "The endpoint is unreachable.");
    const body = await res.json() as { stored?: { id?: string }[]; skipped?: { id?: string }[]; next_seq?: unknown };
    for (const row of body.stored ?? []) if (typeof row.id === "string") known.add(row.id);
    for (const row of body.skipped ?? []) if (typeof row.id === "string") known.add(row.id);
    if (typeof body.next_seq === "number" && body.next_seq >= 1) lastSeq = body.next_seq - 1;
    await persist();
    await remember([]);
    return { ok: true, code: "ok", message: "Synced.", lastSeq };
  }
  return fail("sync_busy", SYNC_BUSY);
}

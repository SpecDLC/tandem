// Acceptance checks for actor objects, focus minutes, and the log file.
import test from "node:test";
import assert from "node:assert/strict";
import { Session, bind } from "../src/registry.ts";
import { EVENT_TYPES, LOG_FORMAT, LOG_VERSION, MemoryStore, formatLogFile, parseLogFile, toJsonl } from "../src/log.ts";

const T0 = Date.parse("2026-10-14T18:00:00.000Z");
const PATRICK = { kind: "human", name: "Patrick" };
const TEXIAN = { kind: "agent", name: "Texian" };
const TYPES = [
  "com.specdlc.tandem.task_imported.v1",
  "com.specdlc.tandem.task_added.v1",
  "com.specdlc.tandem.task_completed.v1",
  "com.specdlc.tandem.pomodoro_started.v1",
  "com.specdlc.tandem.pomodoro_paused.v1",
  "com.specdlc.tandem.pomodoro_resumed.v1",
  "com.specdlc.tandem.pomodoro_stopped.v1",
  "com.specdlc.tandem.pomodoro_finished.v1",
];

function make() {
  const clock = { t: T0 };
  const s = new Session(new MemoryStore(), () => clock.t);
  return { s, clock, human: bind(s, PATRICK), agent: bind(s, TEXIAN) };
}

const legacy = (extra = {}) => ({
  specversion: "1.0",
  id: "01LEGACYTASK00000000000001",
  source: "urn:specdlc:tandem",
  type: "com.specdlc.tandem.task_added.v1",
  subject: "t-old",
  time: "2026-10-14T18:00:00.000Z",
  datacontenttype: "application/json",
  dataschema: "urn:specdlc:schema:tandem.session:1",
  actor: "human:local",
  data: { task_id: "t-old", title: "Old task" },
  ...extra,
});

test("1. a command with an actor shows that name in the activity feed", async () => {
  const { s, agent } = make();
  await agent.add_task("Write the note");
  const row = s.activity.newest(1)[0];
  assert.equal(row.name, "Texian");
  assert.equal(row.text, "Texian added “Write the note”");
  assert.deepEqual(s.exportEvents().events[0].actor, TEXIAN);
});

test("2 and 3. minutes 22 run 22 minutes; a start with no length stores 25", async () => {
  const { s, clock, human } = make();
  const { task_id } = await human.add_task("Focus");
  const started = await human.start_pomodoro(task_id, 22);
  assert.equal(started.ok, true);
  assert.equal(started.minutes, 22);
  assert.equal(started.ends_at, "2026-10-14T18:22:00.000Z");
  const start = s.exportEvents().events.at(-1);
  assert.equal(start.data.minutes, 22);
  assert.equal(start.data.focus_seconds, 22 * 60);
  assert.equal(human.get_status().remaining_seconds, 22 * 60);
  assert.equal(human.get_status().focus_minutes, 22);
  clock.t += 22 * 60 * 1000 - 1000;
  assert.equal(human.get_status().phase, "focus");
  clock.t += 1000;
  assert.equal((await s.finishPomodoro()).ok, true);
  assert.equal(s.activity.newest(1)[0].text, "Patrick finished a 22-minute focus on “Focus”");

  const again = await human.start_pomodoro(task_id);
  assert.equal(again.minutes, 25);
  const plain = s.exportEvents().events.at(-1);
  assert.equal(plain.data.minutes, 25);
  assert.equal(plain.data.focus_seconds, 1500);
  assert.equal(human.get_status().focus_minutes, 25);
  assert.deepEqual(await human.start_pomodoro(task_id, 0), { ok: false, code: "invalid_payload" });
  assert.deepEqual(await human.start_pomodoro(task_id, 181), { ok: false, code: "invalid_payload" });
});

test("4. a pre-change log imports with unknown actor and 25 minutes, and the old line stays", async () => {
  const start = {
    specversion: "1.0",
    id: "01LEGACYSTART0000000000001",
    source: "urn:specdlc:tandem",
    type: "com.specdlc.tandem.pomodoro_started.v1",
    subject: "p-old",
    time: "2026-10-14T18:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "urn:specdlc:schema:tandem.session:1",
    actor: "agent:local",
    data: {
      pomodoro_id: "p-old", task_id: "t-old", focus_seconds: 1500, break_seconds: 300,
      ends_at: "2026-10-14T18:25:00.000Z",
    },
  };
  const missing = { ...legacy(), id: "01LEGACYNONE0000000000001", subject: "t-none", actor: undefined, data: { task_id: "t-none", title: "No actor" } };
  delete missing.actor;
  const file = `${JSON.stringify(legacy())}\n${JSON.stringify(start)}\n${JSON.stringify(missing)}\n`;
  const parsed = parseLogFile(file);
  assert.equal(parsed.ok, true);
  const s = new Session(new MemoryStore(), () => T0);
  const imported = await s.importEvents(parsed.events);
  assert.equal(imported.imported, 3);
  const stored = s.exportEvents().events;
  const byId = Object.fromEntries(stored.map((e) => [e.id, e]));
  // One new batch is ordered by recorded time, then id. These three share a time, so id order is the stored order.
  assert.deepEqual(stored.map((e) => e.id), [missing.id, start.id, legacy().id]);
  assert.equal(byId[legacy().id].actor, "human:local");
  assert.equal(byId[start.id].actor, "agent:local");
  assert.equal("minutes" in byId[start.id].data, false);
  assert.equal(byId[missing.id].actor, undefined);
  assert.equal(s.activity.newest(3).map((row) => row.name).every((n) => n === "unknown actor"), true);
  assert.equal(s.getStatus().focus_minutes, 25);
  assert.equal(s.getStatus().remaining_seconds, 1500);
  assert.equal(toJsonl([byId[start.id]]), `${JSON.stringify(start)}\n`);
});

test("5. no new event types are added", () => {
  assert.deepEqual(Object.values(EVENT_TYPES), TYPES);
});

test("6. the exported log file starts with a format header", async () => {
  const { s, human } = make();
  await human.add_task("One");
  const file = formatLogFile(s.exportEvents().events);
  const [header, event] = file.split("\n");
  assert.deepEqual(JSON.parse(header), { format: LOG_FORMAT, version: LOG_VERSION });
  assert.equal(JSON.parse(event).type, EVENT_TYPES.taskAdded);
  const round = parseLogFile(file);
  assert.equal(round.ok, true);
  assert.equal(round.events.length, 1);
});

test("7. a bad file is rejected as a whole and import does not call the network", async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(String(args[0])); return previous(...args); };
  try {
    const good = legacy();
    const file = `${JSON.stringify({ format: LOG_FORMAT, version: LOG_VERSION })}\n${JSON.stringify(good)}\nnot-json\n`;
    assert.deepEqual(parseLogFile(file), { ok: false, code: "invalid_events" });
    assert.deepEqual(parseLogFile(`${JSON.stringify({ format: "tandem.session-log", version: 2 })}\n${JSON.stringify(good)}\n`), { ok: false, code: "invalid_events" });
    const { s, human } = make();
    await human.add_task("Keep me");
    const before = toJsonl(s.exportEvents().events);
    const rejected = await human.import_events([good, { ...good, id: "bad", type: "com.specdlc.tandem.note_added.v1" }]);
    assert.deepEqual(rejected, { ok: false, code: "invalid_events" });
    assert.equal(toJsonl(s.exportEvents().events), before);
    formatLogFile(s.exportEvents().events);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = previous;
  }
});

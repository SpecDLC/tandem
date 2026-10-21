// Module witnesses for the command registry, log, and projection.
// These import the build's modules, so they corroborate the reference build only, not a portable card.
import test from "node:test";
import assert from "node:assert/strict";
import { CloudEvent } from "cloudevents";
import { Session, bind, COMMAND_NAMES } from "../src/registry.ts";
import { MemoryStore, toJsonl, parseJsonl, SOURCE } from "../src/log.ts";
import { foldBoard, project } from "../src/project.ts";
import { commitTitle } from "../src/addControl.ts";
import { PAUSED_ROLL_OFF_MS } from "../src/timer.ts";

const T0 = Date.parse("2026-10-14T18:00:00.000Z");
function make() {
  const clock = { t: T0 };
  const store = new MemoryStore();
  const s = new Session(store, () => clock.t);
  return { s, clock, store, human: bind(s, "human"), agent: bind(s, "agent") };
}
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const fixture = () => ({
  schema: "tandem.tasks/v0",
  tasks: [
    { id: "a", title: "A" }, { id: "b", title: "B", estimate_pomodoros: 2, notes: "n" }, { title: "C" },
    { id: "d" }, { id: "a", title: "dup" }, { id: "e", title: "E", mystery: 1 },
  ],
});

test("registry names are the declared commands", () => {
  const { human, agent } = make();
  assert.deepEqual(Object.keys(human), [...COMMAND_NAMES]);
  assert.deepEqual(Object.keys(agent), [...COMMAND_NAMES]);
  assert.ok(!COMMAND_NAMES.includes("pomodoro.finished"));
});

test("import fixture: accepted 4, rejected 1 with path, skipped 1, unknown field reported not stored", async () => {
  const { s, human } = make();
  const r = await human.import_tasks(fixture());
  assert.equal(r.accepted, 4);
  assert.deepEqual(r.rejected, [{ path: "tasks[3].title", code: "missing_title" }]);
  assert.deepEqual(r.skipped, [{ id: "a", code: "duplicate_id" }]);
  assert.deepEqual(r.ignored_fields, [{ path: "tasks[5].mystery" }]);
  const list = human.list_tasks().tasks;
  assert.deepEqual(list.map((t) => t.title), ["A", "B", "C", "E"]);
  assert.ok(ULID.test(list[2].task_id), "missing id gets a ULID");
  assert.equal(list[1].estimate_pomodoros, 2);
  const e = s.exportEvents().events.find((x) => x.subject === "e");
  assert.ok(!("mystery" in e.data));
  assert.deepEqual(Object.keys(s.exportEvents().events[1].data), ["task_id", "title", "estimate_pomodoros", "notes"]);
});

test("import rejects: wrong/missing schema, non-object, bad tasks, bad rows; nothing written", async () => {
  const { s, human } = make();
  for (const p of [{ schema: "tandem.tasks/v1", tasks: [] }, { tasks: [] }]) {
    assert.deepEqual(await human.import_tasks(p), { ok: false, code: "unsupported_schema" });
  }
  for (const p of [null, [], "x", { schema: "tandem.tasks/v0" }, { schema: "tandem.tasks/v0", tasks: {} }]) {
    assert.deepEqual(await human.import_tasks(p), { ok: false, code: "invalid_payload" });
  }
  const r = await human.import_tasks({ schema: "tandem.tasks/v0", tasks: [1, { title: 3 }, { title: "x", estimate_pomodoros: -1 }, { title: "x", notes: 4 }, { title: "x", id: 5 }] });
  assert.equal(r.accepted, 0);
  assert.deepEqual(r.rejected.map((x) => x.code), ["invalid_payload", "missing_title", "invalid_payload", "invalid_payload", "invalid_payload"]);
  assert.equal(s.exportEvents().events.length, 0);
});

test("import duplicate against the log and within one payload", async () => {
  const { human } = make();
  await human.import_tasks({ schema: "tandem.tasks/v0", tasks: [{ id: "a", title: "A" }] });
  const r = await human.import_tasks({ schema: "tandem.tasks/v0", tasks: [{ id: "a", title: "A" }, { id: "z", title: "Z" }, { id: "z", title: "Z" }] });
  assert.equal(r.accepted, 1);
  assert.deepEqual(r.skipped.map((x) => x.id), ["a", "z"]);
});

test("add_task and complete_task rules", async () => {
  const { s, human } = make();
  assert.deepEqual(await human.add_task(""), { ok: false, code: "missing_title" });
  assert.deepEqual(await human.add_task("x", 1.5), { ok: false, code: "invalid_payload" });
  const { task_id } = await human.add_task("x", 1);
  assert.equal(human.list_tasks("open").tasks.length, 1);
  assert.deepEqual(await human.complete_task("nope"), { ok: false, code: "unknown_task" });
  assert.equal((await human.complete_task(task_id)).ok, true);
  assert.deepEqual(await human.complete_task(task_id), { ok: false, code: "task_not_open" });
  assert.equal(human.list_tasks("open").tasks.length, 0);
  assert.equal(human.list_tasks("completed").tasks.length, 1);
  assert.equal(human.list_tasks().tasks.length, 1);
  assert.deepEqual(human.list_tasks("bogus"), { ok: false, code: "invalid_payload" });
  assert.equal(s.exportEvents().events.length, 2);
});

test("timer rules: start/stop/finish/break/idle and rejections write nothing", async () => {
  const { s, clock, human } = make();
  const { task_id } = await human.add_task("x");
  const done = (await human.add_task("done")).task_id;
  await human.complete_task(done);
  const n = () => s.exportEvents().events.length;
  assert.deepEqual(human.get_status(), { ok: true, phase: "idle", task_id: null, task_title: null, pomodoro_id: null, remaining_seconds: 0, paused: [] });
  assert.deepEqual(await human.stop_pomodoro(), { ok: false, code: "no_running_pomodoro" });
  const before = n();
  assert.deepEqual(await human.start_pomodoro("nope"), { ok: false, code: "unknown_task" });
  assert.deepEqual(await human.start_pomodoro(done), { ok: false, code: "task_not_open" });
  assert.equal(n(), before);

  const st = await human.start_pomodoro(task_id);
  assert.equal(st.ends_at, "2026-10-14T18:25:00.000Z");
  assert.deepEqual(await human.start_pomodoro(task_id), { ok: false, code: "pomodoro_already_running" });
  const g = human.get_status();
  assert.deepEqual([g.phase, g.task_title, g.remaining_seconds], ["focus", "x", 1500]);
  assert.deepEqual(await s.finishPomodoro(), { ok: false, code: "pomodoro_not_finished" });
  assert.equal(n(), before + 1);

  // Completing during a run keeps the timer running.
  await human.complete_task(task_id);
  assert.equal(human.get_status().phase, "focus");

  clock.t = T0 + 1500_000;
  assert.equal((await s.finishPomodoro()).ok, true);
  assert.deepEqual(await s.finishPomodoro(), { ok: false, code: "no_running_pomodoro" });
  const fin = s.exportEvents().events.filter((e) => e.type.endsWith("pomodoro_finished.v1"));
  assert.equal(fin.length, 1);
  assert.equal(fin[0].time, "2026-10-14T18:25:00.000Z");
  assert.deepEqual(Object.keys(fin[0].data), ["pomodoro_id", "task_id"]);
  const b = human.get_status();
  assert.deepEqual([b.phase, b.task_id, b.remaining_seconds, b.pomodoro_id], ["break", task_id, 300, null]);
  clock.t += 299_000;
  assert.equal(human.get_status().remaining_seconds, 1);
  clock.t += 1000;
  assert.equal(human.get_status().phase, "idle");
});

test("start during break is allowed; stop during break rejected; stop while running", async () => {
  const { s, clock, human } = make();
  const { task_id } = await human.add_task("x");
  await human.start_pomodoro(task_id);
  clock.t += 1500_000;
  await s.finishPomodoro();
  assert.equal(human.get_status().phase, "break");
  assert.deepEqual(await human.stop_pomodoro(), { ok: false, code: "no_running_pomodoro" });
  const again = await human.start_pomodoro(task_id);
  assert.equal(again.ok, true);
  assert.equal((await human.stop_pomodoro()).ok, true);
  assert.equal(human.get_status().phase, "idle");
});

test("a start after the scheduled end records the finish first (finish copies the start actor, time is the scheduled end)", async () => {
  const { s, clock, agent, human } = make();
  const { task_id } = await human.add_task("x");
  await agent.start_pomodoro(task_id);
  clock.t += 1600_000;
  assert.equal((await human.start_pomodoro(task_id)).ok, true);
  const ev = s.exportEvents().events;
  const fin = ev.find((e) => e.type.endsWith("pomodoro_finished.v1"));
  assert.equal(fin.actor, "agent:local");
  assert.equal(fin.time, "2026-10-14T18:25:00.000Z");
  assert.equal(ev.at(-1).actor, "human:local");
});

test("parity: same domain facts from human and agent, rejections identical", async () => {
  const run = async (kind) => {
    const { s, clock, ...c } = make();
    const api = c[kind];
    const r = await api.import_tasks({ schema: "tandem.tasks/v0", tasks: [{ id: "1", title: "a" }, { id: "2", title: "b" }, { id: "3", title: "c" }] });
    await api.start_pomodoro("1"); await api.stop_pomodoro(); await api.complete_task("1");
    const rej = [await api.start_pomodoro("1"), await api.stop_pomodoro(), await api.import_tasks({}), await api.export_events("zzz")];
    const mask = s.exportEvents().events.map((e) => ({ type: e.type, subject: e.type.includes("pomodoro") ? "p" : e.subject, data: { ...e.data, pomodoro_id: undefined, ends_at: undefined } }));
    return { r: r.accepted, mask, rej, actors: new Set(s.exportEvents().events.map((e) => e.actor.split(":")[0])) };
  };
  const h = await run("human"), a = await run("agent");
  assert.deepEqual(h.mask, a.mask);
  assert.deepEqual(h.rej, a.rej);
  assert.deepEqual([...h.actors], ["human"]);
  assert.deepEqual([...a.actors], ["agent"]);
});

test("events: ULID ids, CloudEvents core, key order, actor, one line each", async () => {
  const { s, human } = make();
  await human.import_tasks(fixture());
  const jsonl = toJsonl(s.exportEvents().events);
  const lines = jsonl.split("\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines.length - 1, 4);
  for (const l of lines.slice(0, -1)) {
    const e = JSON.parse(l);
    assert.deepEqual(Object.keys(e), ["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema", "actor", "data"]);
    assert.ok(ULID.test(e.id));
    assert.equal(e.source, SOURCE);
    assert.equal(e.specversion, "1.0");
    assert.equal(e.actor, "human:local");
  }
});

test("events validate as CloudEvents 1.0 with the official SDK", async () => {
  const { s, clock, human } = make();
  await human.import_tasks(fixture());
  const t = (await human.add_task("x")).task_id;
  await human.start_pomodoro(t); clock.t += 1500_000; await s.finishPomodoro(); await human.complete_task(t);
  const events = s.exportEvents().events;
  assert.ok(events.length >= 8);
  for (const e of events) {
    const ce = new CloudEvent(e); // throws ValidationError on a non-conformant event
    assert.equal(ce.validate(), true);
    assert.deepEqual(JSON.parse(JSON.stringify(ce)).id, e.id);
    assert.equal(ce.source, SOURCE);
    assert.equal(ce.actor, e.actor);
  }
  assert.throws(() => new CloudEvent({ ...events[0], specversion: "0.3" }));
});

test("replay of the JSONL equals the live projection", async () => {
  const { s, clock, human, agent } = make();
  await human.import_tasks(fixture());
  const t = (await human.add_task("x")).task_id;
  await agent.start_pomodoro(t); clock.t += 1500_000; await s.finishPomodoro();
  await human.complete_task("a"); clock.t += 10_000;
  const jsonl = toJsonl(s.exportEvents().events);
  const replay = project(parseJsonl(jsonl));
  assert.deepEqual(replay.list(), human.list_tasks().tasks);
  assert.deepEqual(replay.status(clock.t), (({ ok, ...r }) => r)(human.get_status()));
  // a fresh session fed the same file via import_events reaches the same state, and so does a reopen
  const fresh = new Session(new MemoryStore(), () => clock.t);
  assert.equal((await fresh.importEvents(parseJsonl(jsonl))).imported, s.exportEvents().events.length);
  assert.deepEqual(fresh.listTasks(), human.list_tasks());
  assert.deepEqual(fresh.getStatus(), human.get_status());
  assert.deepEqual(s.replayProjection().list(), human.list_tasks().tasks);
});

test("working copy: discard and import restores state; reopen from store; ids kept", async () => {
  const { s, clock, store, human } = make();
  await human.import_tasks(fixture());
  const t = (await human.add_task("x")).task_id;
  await human.start_pomodoro(t);
  const exp = s.exportEvents();
  const reopened = await Session.open(store, () => clock.t);
  assert.deepEqual(reopened.exportEvents(), exp);
  const fresh = new Session(new MemoryStore(), () => clock.t);
  await fresh.importEvents(JSON.parse(JSON.stringify(exp.events)));
  assert.deepEqual(fresh.listTasks(), human.list_tasks());
  assert.deepEqual(fresh.getStatus(), human.get_status());
  assert.deepEqual(fresh.exportEvents().events.map((e) => e.id), exp.events.map((e) => e.id));
  assert.equal(toJsonl(fresh.exportEvents().events), toJsonl(exp.events));
});

test("export is a byte prefix after another command", async () => {
  const { human, s } = make();
  await human.import_tasks(fixture());
  const first = toJsonl(s.exportEvents().events);
  await human.add_task("more");
  await human.complete_task("a");
  const second = toJsonl(s.exportEvents().events);
  assert.ok(second.length > first.length && second.startsWith(first));
});

test("cursor: empty log, full export, later only, twice adds no duplicate id, append order not ULID order", async () => {
  const { s, human } = make();
  assert.deepEqual(human.export_events(), { ok: true, events: [], cursor: "" });
  await human.import_tasks(fixture());
  const first = human.export_events("");
  assert.equal(first.events.length, 4);
  assert.equal(first.cursor, first.events.at(-1).id);
  const empty = human.export_events(first.cursor);
  assert.deepEqual([empty.events.length, empty.cursor], [0, first.cursor]);
  // Imported event with an id that sorts BEFORE the cursor is still exported afterwards.
  const early = { ...first.events[0], id: "00000000000000000000000000", subject: "z", data: { task_id: "z", title: "Z" } };
  assert.equal((await human.import_events([early])).imported, 1);
  const later = human.export_events(first.cursor);
  assert.deepEqual(later.events.map((e) => e.id), ["00000000000000000000000000"]);
  // Two cursor exports, applied to a file, add no duplicate id.
  const file = [...first.events, ...later.events];
  await human.add_task("y");
  const again = human.export_events(later.cursor);
  const ids = [...file, ...again.events].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(human.export_events("not-a-cursor"), { ok: false, code: "unknown_cursor", events: [], cursor: "not-a-cursor" });
  assert.equal(s.exportEvents(5).code, "unknown_cursor");
});

test("import_events: keeps ids, skips duplicates, reports invalid, rejects non-array, does not re-run rules", async () => {
  const { s, human } = make();
  assert.deepEqual(await human.import_events({}), { ok: false, code: "invalid_events" });
  await human.add_task("x");
  const ev = s.exportEvents().events[0];
  const r = await human.import_events([ev, { ...ev, id: "N1", type: "com.specdlc.tandem.task_completed.v1", subject: "ghost", data: { task_id: "ghost" } }, { ...ev, id: "N2", source: "urn:other" }, 7, { ...ev, id: "N3", time: "yesterday" }]);
  assert.equal(r.imported, 1);
  assert.deepEqual(r.skipped, [{ id: ev.id, code: "duplicate_id" }]);
  assert.deepEqual(r.rejected.map((x) => [x.path, x.code]), [["events[2]", "invalid_event"], ["events[3]", "invalid_event"], ["events[4]", "invalid_event"]]);
  assert.ok(s.exportEvents().events.some((e) => e.id === "N1"));
  assert.equal(human.list_tasks().tasks.length, 1);
});

test("concurrent commands do not interleave: two starts yield one pomodoro", async () => {
  const { s, human } = make();
  const { task_id } = await human.add_task("x");
  const [a, b] = await Promise.all([human.start_pomodoro(task_id), human.start_pomodoro(task_id)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(s.exportEvents().events.filter((e) => e.type.endsWith("pomodoro_started.v1")).length, 1);
});

test("rapid add_task calls keep every title in commit order, with no missing_title", async () => {
  const { human } = make();
  const rs = await Promise.all(["one", "two", "three", "four", "five"].map((t) => human.add_task(t)));
  assert.ok(rs.every((r) => r.ok));
  assert.deepEqual(human.list_tasks().tasks.map((t) => t.title), ["one", "two", "three", "four", "five"]);
});

const boardOf = (s, now, includeStale = false) => foldBoard(s.exportEvents().events, now, PAUSED_ROLL_OFF_MS, includeStale);
const withoutOk = ({ ok, ...rest }) => rest;

test("pause and resume are events, and the same now rebuilds the same board", async () => {
  const { s, clock, human, agent } = make();
  assert.equal(PAUSED_ROLL_OFF_MS, 3 * 24 * 60 * 60 * 1000);
  const { task_id } = await human.add_task("x");
  await human.start_pomodoro(task_id);
  const before = s.exportEvents().events.length;
  // Pause is focus-only. A timer that has reached its end finishes instead, and break or idle writes nothing.
  clock.t = T0 + 1500_000;
  assert.deepEqual(await human.pause_pomodoro(), { ok: false, code: "no_running_pomodoro" });
  assert.equal(human.get_status().phase, "break");
  assert.equal(s.exportEvents().events.filter((e) => e.type.endsWith("pomodoro_paused.v1")).length, 0);
  clock.t = T0 + 1500_000 + 300_000;
  assert.equal(human.get_status().phase, "idle");
  assert.deepEqual(await human.pause_pomodoro(), { ok: false, code: "no_running_pomodoro" });
  assert.equal(s.exportEvents().events.length, before + 1);

  clock.t = T0 + 2_000_000;
  await agent.start_pomodoro(task_id);
  clock.t += 40_000;
  const pausedAt = clock.t;
  const held = await human.pause_pomodoro();
  assert.equal(held.ok, true);
  assert.equal(held.remaining_seconds, 1460);
  const paused = s.exportEvents().events.at(-1);
  assert.equal(paused.type, "com.specdlc.tandem.pomodoro_paused.v1");
  assert.equal(paused.subject, held.pomodoro_id);
  assert.equal(paused.time, new Date(pausedAt).toISOString());
  assert.equal(paused.actor, "human:local");
  assert.deepEqual(Object.keys(paused.data), ["pomodoro_id", "remaining_seconds"]);
  assert.equal(new CloudEvent(paused).validate(), true);
  assert.equal(s.activity.newest(1)[0].text, "You paused the timer");
  const card = human.get_status();
  assert.equal(card.phase, "paused");
  assert.equal(card.remaining_seconds, 1460);
  assert.equal(card.paused.length, 1);
  assert.equal(card.paused[0].paused_at, paused.time);
  assert.equal(card.paused[0].age_ms, 0);
  assert.equal(card.paused[0].task_title, "x");
  // Past the original end, a paused pomodoro does not finish and does not enter the break.
  clock.t = pausedAt + 1500_000 + 300_000;
  assert.equal(s.exportEvents().events.filter((e) => e.type.endsWith("pomodoro_finished.v1")).length, 1);
  assert.equal(human.get_status().phase, "paused");
  assert.equal(human.get_status().remaining_seconds, 1460);
  assert.deepEqual(await s.finishPomodoro(), { ok: false, code: "no_running_pomodoro" });

  const resumedAt = clock.t;
  const resumed = await agent.resume_pomodoro(held.pomodoro_id);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.ends_at, new Date(resumedAt + 1460_000).toISOString());
  const resumeEv = s.exportEvents().events.at(-1);
  assert.equal(resumeEv.type, "com.specdlc.tandem.pomodoro_resumed.v1");
  assert.equal(resumeEv.subject, held.pomodoro_id);
  assert.equal(resumeEv.actor, "agent:local");
  assert.equal(resumeEv.time, new Date(resumedAt).toISOString());
  assert.deepEqual(Object.keys(resumeEv.data), ["pomodoro_id", "ends_at"]);
  assert.deepEqual([human.get_status().phase, human.get_status().remaining_seconds], ["focus", 1460]);
  clock.t += 10_000;
  assert.equal(human.get_status().remaining_seconds, 1450);
  assert.equal(s.activity.newest(1)[0].text, "Agent resumed focus on “x”");

  const again = clock.t;
  await human.pause_pomodoro();
  const events = s.exportEvents().events;
  const live = withoutOk(human.get_status());
  assert.deepEqual(foldBoard(events, again, PAUSED_ROLL_OFF_MS, false), live);
  assert.deepEqual(foldBoard(events, again, PAUSED_ROLL_OFF_MS, false), foldBoard(parseJsonl(toJsonl(events)), again, PAUSED_ROLL_OFF_MS, false));
  assert.deepEqual(project(events).board(again, PAUSED_ROLL_OFF_MS, true), foldBoard(events, again, PAUSED_ROLL_OFF_MS, true));
});

test("paused roll-off is a projection: in-window, the boundary, stop, and stale resume", async () => {
  const { s, clock, human } = make();
  const { task_id } = await human.add_task("x");
  const other = (await human.add_task("y")).task_id;
  await human.start_pomodoro(task_id);
  clock.t = T0 + 60_000;
  const first = await human.pause_pomodoro();
  const pausedAt = clock.t;
  const lengthAtPause = s.exportEvents().events.length;

  clock.t = pausedAt + PAUSED_ROLL_OFF_MS - 1;
  const inside = human.get_status();
  assert.equal(inside.phase, "paused");
  assert.equal(inside.paused.length, 1);
  assert.equal(inside.paused[0].age_ms, PAUSED_ROLL_OFF_MS - 1);
  assert.deepEqual(await human.start_pomodoro(other), { ok: false, code: "pomodoro_already_running" });
  assert.equal(s.exportEvents().events.length, lengthAtPause);

  clock.t = pausedAt + PAUSED_ROLL_OFF_MS;
  const outside = human.get_status();
  assert.deepEqual([outside.phase, outside.paused.length, outside.remaining_seconds], ["idle", 0, 0]);
  assert.equal(s.exportEvents().events.length, lengthAtPause);
  const shown = boardOf(s, clock.t, true);
  assert.equal(shown.phase, "idle");
  assert.equal(shown.paused.length, 1);
  assert.equal(shown.paused[0].pomodoro_id, first.pomodoro_id);
  assert.equal(shown.paused[0].age_ms, PAUSED_ROLL_OFF_MS);
  assert.deepEqual(boardOf(s, clock.t, true), boardOf(s, clock.t, true));
  assert.deepEqual(await human.stop_pomodoro(), { ok: false, code: "no_running_pomodoro" });
  assert.equal(s.exportEvents().events.length, lengthAtPause);
  assert.equal(boardOf(s, clock.t, true).paused.length, 1);

  assert.equal((await human.start_pomodoro(other)).ok, true);
  assert.deepEqual(await human.resume_pomodoro(first.pomodoro_id), { ok: false, code: "pomodoro_already_running" });
  await human.stop_pomodoro();
  clock.t += 1_000;
  await human.start_pomodoro(task_id);
  await human.pause_pomodoro();
  assert.equal(human.get_status().phase, "paused");
  assert.deepEqual(await human.resume_pomodoro(first.pomodoro_id), { ok: false, code: "pomodoro_already_running" });
  assert.deepEqual(await human.start_pomodoro(other), { ok: false, code: "pomodoro_already_running" });
  const closed = await human.stop_pomodoro();
  assert.equal(closed.ok, true);
  const tail = s.exportEvents().events.at(-1);
  assert.equal(tail.type, "com.specdlc.tandem.pomodoro_stopped.v1");
  assert.equal(tail.subject, closed.pomodoro_id);
  assert.deepEqual(Object.keys(tail.data), ["pomodoro_id"]);
  assert.equal(s.exportEvents().events.some((e) => e.type.includes("closed")), false);
  assert.equal(human.get_status().phase, "idle");
  assert.equal(human.get_status().paused.length, 0);

  const back = await human.resume_pomodoro(first.pomodoro_id);
  assert.equal(back.ok, true);
  assert.equal(human.get_status().phase, "focus");
  assert.equal(human.get_status().remaining_seconds, first.remaining_seconds);
  assert.equal(human.get_status().pomodoro_id, first.pomodoro_id);
  assert.deepEqual(await human.resume_pomodoro("missing"), { ok: false, code: "no_paused_pomodoro" });
  assert.deepEqual(await human.resume_pomodoro(""), { ok: false, code: "invalid_payload" });
});

test("closing a stale paused card stops that pomodoro; omitting the id still writes nothing", async () => {
  const { s, clock, human } = make();
  const { task_id } = await human.add_task("x");
  await human.start_pomodoro(task_id);
  clock.t = T0 + 60_000;
  const held = await human.pause_pomodoro();
  const pausedAt = clock.t;
  clock.t = pausedAt + PAUSED_ROLL_OFF_MS;
  const before = s.exportEvents().events.length;
  assert.deepEqual(await human.stop_pomodoro(), { ok: false, code: "no_running_pomodoro" });
  assert.equal(s.exportEvents().events.length, before);
  assert.equal(s.screenBoard(true).paused.length, 1);
  const closed = await human.stop_pomodoro(held.pomodoro_id);
  assert.equal(closed.ok, true);
  assert.equal(closed.pomodoro_id, held.pomodoro_id);
  const tail = s.exportEvents().events.at(-1);
  assert.equal(tail.type, "com.specdlc.tandem.pomodoro_stopped.v1");
  assert.deepEqual(Object.keys(tail.data), ["pomodoro_id"]);
  assert.equal(s.screenBoard(true).paused.length, 0);
  assert.equal(s.exportEvents().events.length, before + 1);
  assert.deepEqual(s.screenBoard(false), s.screenBoard(false));
});

test("commitTitle empties the box at commit, so a title typed before the add resolves survives", async () => {
  const { human } = make();
  const box = { value: "" };
  const sent = [];
  const add = (t) => { sent.push(t); return human.add_task(t); };
  const pending = [];
  for (const t of ["one", "two", "three"]) { box.value = t; pending.push(commitTitle(box, add)); }
  await Promise.all(pending);
  assert.deepEqual(sent, ["one", "two", "three"]);
  assert.equal(box.value, "");
  box.value = "   ";
  assert.deepEqual(await commitTitle(box, add), { ok: false, code: "missing_title" });
  assert.equal(box.value, "   ");
  assert.deepEqual(human.list_tasks().tasks.map((t) => t.title), ["one", "two", "three"]);
});

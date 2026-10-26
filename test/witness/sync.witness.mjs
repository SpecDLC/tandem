// Interface-level witnesses for TANDEM-TECH-LOG-3, TANDEM-FUNC-COACH-1, and TANDEM-FUNC-DEBUG-1.
// The agent path is document.modelContext only. The sync is the published script, run as a child process on the
// tool result. Nothing here imports an application module.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT, serve, launch, openSession, screen, events, click } from "./support.mjs";

// The public tree, cloned next to this repo in CI or given by TANDEM_PUBLIC. The sync script is read from there.
const PUBLIC = process.env.TANDEM_PUBLIC ?? new URL("../../../tandem/", import.meta.url).pathname;
const SYNC = join(PUBLIC, "scripts/sync-jsonl.mjs");

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const importLog = async (page, list) => {
  await page.fill("#events-input", list.map((e) => JSON.stringify(e)).join("\n"));
  await click(page, "[data-command='import_events']");
  return screen(page);
};

const tool = (page, name, input) => page.evaluate(async ([n, i]) => {
  const t = (await document.modelContext.getTools()).find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return JSON.parse(await document.modelContext.executeTool(t, i));
}, [name, { actor: AGENT, ...(input ?? {}) }]);

const sync = (file, result) => {
  const r = spawnSync("node", [SYNC, file], { input: JSON.stringify(result), encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const tmp = () => join(mkdtempSync(join(tmpdir(), "tandem-sync-")), "Tandem", "events.jsonl");

const FIXTURE = { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "Draft spec intro", estimate_pomodoros: 2 }, { id: "t2", title: "Review cards" }, { id: "t3", title: "Write guide" }] };

/** Replay a log without the application: tasks in append order with status, the running pomodoro, and the phase. */
function replay(log, nowMs) {
  const tasks = new Map();
  let running = null, lastFinish = null;
  for (const e of log) {
    const t = e.type.replace("com.specdlc.tandem.", "");
    if (t === "task_imported.v1" || t === "task_added.v1") tasks.set(e.data.task_id, { id: e.data.task_id, title: e.data.title, status: "open" });
    else if (t === "task_completed.v1") tasks.get(e.data.task_id).status = "completed";
    else if (t === "pomodoro_started.v1") { running = { task_id: e.data.task_id, ends: Date.parse(e.data.ends_at), brk: e.data.break_seconds }; lastFinish = null; }
    else if (t === "pomodoro_stopped.v1") running = null;
    else if (t === "pomodoro_finished.v1") { lastFinish = { task_id: e.data.task_id, until: Date.parse(e.time) + running.brk * 1000 }; running = null; }
  }
  const phase = running ? "focus" : lastFinish && nowMs < lastFinish.until ? "break" : "idle";
  const at = running?.task_id ?? (phase === "break" ? lastFinish.task_id : null);
  return { tasks: [...tasks.values()], phase, task_title: at ? tasks.get(at).title : null };
}

/** TANDEM-FUNC-DEBUG-1: compare screen, tools, and log in a fixed order and name the first disagreement. */
function confirm({ screen: s, tools, log }) {
  const views = { screen: s, tools, log };
  const checks = [
    ["task ids and order", (v) => v.tasks.map((t) => t.id).join(",")],
    ...[0, 1, 2, 3, 4, 5].map((i) => [`status of task #${i + 1}`, (v) => v.tasks[i]?.status ?? "(none)"]),
    ["phase", (v) => v.phase],
    ["running or break task title", (v) => v.task_title ?? "(none)"],
  ];
  for (const [field, get] of checks) {
    const got = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, get(v)]));
    if (new Set(Object.values(got)).size > 1) return { agree: false, first: { field, ...got } };
  }
  return { agree: true };
}

async function views(page, nowMs) {
  const s = await screen(page);
  const list = await tool(page, "list_tasks");
  const st = await tool(page, "get_status");
  const exp = await tool(page, "export_events");
  return {
    exp,
    v: {
      screen: { tasks: s.tasks.map((t) => ({ id: t.id, status: t.status })), phase: s.status.phase, task_title: s.status.taskTitle },
      tools: { tasks: list.tasks.map((t) => ({ id: t.task_id, status: t.status })), phase: st.phase, task_title: st.task_title ?? null },
      log: replay(exp.events, nowMs),
    },
  };
}

test("TANDEM-TECH-LOG-3: sync from an empty cursor replays to the session; a second sync adds nothing; append order; unknown_cursor", async () => {
  const { context, page } = await openSession(browser, server.url);
  await tool(page, "import_tasks", FIXTURE);
  await tool(page, "start_pomodoro", { task_id: "t1" });
  const file = tmp();

  const first = await tool(page, "export_events");
  assert.equal(first.events.length, 4);
  assert.match(sync(file, first).out, /appended 4, skipped 0/);
  assert.equal(lines(file).length, 4);

  // The file replays to the same list and status the session shows.
  const fresh = await openSession(browser, server.url);
  const imp = await importLog(fresh.page, lines(file).map((l) => JSON.parse(l)));
  assert.match(imp.result, /imported 4, rejected 0, skipped 0/);
  const a = await screen(page), b = await screen(fresh.page);
  assert.deepEqual(b.tasks, a.tasks);
  assert.deepEqual(b.status, a.status);

  // A second sync with the returned cursor: nothing new, nothing duplicated.
  const second = await tool(page, "export_events", { since_cursor: first.cursor });
  assert.deepEqual(second.events, []);
  assert.match(sync(file, second).out, /appended 0, skipped 0/);
  // The same events again are skipped by id.
  assert.match(sync(file, first).out, /appended 0, skipped 4/);
  assert.equal(lines(file).length, 4);

  // The cursor walks append order. An imported event whose id sorts before every id here is still exported.
  const early = { specversion: "1.0", id: "00000000000000000000000001", source: "urn:specdlc:tandem", type: "com.specdlc.tandem.task_added.v1",
    subject: "tearly", time: "2026-10-14T11:00:00.000Z", datacontenttype: "application/json", dataschema: "urn:specdlc:schema:tandem.session:1",
    actor: "human:local", data: { task_id: "tearly", title: "Earlier id, later arrival" } };
  const earlyNote = await importLog(page, [early]);
  assert.match(earlyNote.result, /imported 1, rejected 0, skipped 0/);
  assert.match(earlyNote.result, /Imported 1 event\./);
  const third = await tool(page, "export_events", { since_cursor: first.cursor });
  assert.deepEqual(third.events.map((e) => e.id), [early.id], "found by position, not id magnitude");
  assert.equal(third.events[0].actor, "human:local");
  assert.equal(third.cursor, early.id);
  assert.match(sync(file, third).out, /appended 1, skipped 0/);
  assert.equal(lines(file).length, 5);
  assert.deepEqual(lines(file).map((l) => JSON.parse(l).id), (await tool(page, "export_events")).events.map((e) => e.id));

  // An unknown cursor returns unknown_cursor and no events, and the sync writes nothing.
  const bad = await tool(page, "export_events", { since_cursor: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "unknown_cursor");
  assert.deepEqual(bad.events, []);
  const r = sync(file, bad);
  assert.notEqual(r.code, 0);
  assert.equal(lines(file).length, 5);

  // An empty log gives an empty cursor and no events.
  const empty = await openSession(browser, server.url);
  const none = await tool(empty.page, "export_events");
  assert.deepEqual([none.events, none.cursor], [[], ""]);
  await context.close(); await fresh.context.close(); await empty.context.close();
});

test("TANDEM-FUNC-COACH-1: the scripted tool sequence writes import, start, and finish with actor kind agent and no human event", async () => {
  const { context, page } = await openSession(browser, server.url);
  const called = [];
  const call = async (n, i) => { called.push(n); return tool(page, n, i); };
  // The routine in templates/coach.md, tools only.
  const imp = await call("import_tasks", FIXTURE);
  assert.equal(imp.accepted, 3);
  const open = (await call("list_tasks", { status: "open" })).tasks;
  const started = await call("start_pomodoro", { task_id: open[0].task_id });
  assert.equal(started.ok, true);
  let st = await call("get_status");
  assert.equal(st.phase, "focus");
  await page.clock.fastForward(1501_000);
  await page.waitForFunction(() => document.querySelector("[data-command='get_status']").dataset.phase === "break");
  st = await call("get_status");
  assert.equal(st.phase, "break");
  assert.equal(st.task_title, "Draft spec intro");

  const log = (await tool(page, "export_events")).events;
  assert.deepEqual(log.filter((e) => !e.type.endsWith("task_imported.v1")).map((e) => e.type.replace("com.specdlc.tandem.", "")), ["pomodoro_started.v1", "pomodoro_finished.v1"]);
  assert.equal(log.filter((e) => e.type.endsWith("task_imported.v1")).length, 3);
  assert.deepEqual([...new Set(log.map((e) => JSON.stringify(e.actor)))], [JSON.stringify(AGENT)]);
  assert.equal(log.some((e) => e.actor?.kind === "human"), false);
  assert.deepEqual([...new Set(called)].sort(), ["get_status", "import_tasks", "list_tasks", "start_pomodoro"]);
  await context.close();
});

test("TANDEM-FUNC-DEBUG-1: screen, tools, and log agree; a deliberate mismatch is named at its first disagreement", async () => {
  const { context, page } = await openSession(browser, server.url);
  await tool(page, "import_tasks", FIXTURE);
  await tool(page, "complete_task", { task_id: "t2" });
  await tool(page, "start_pomodoro", { task_id: "t1" });
  const now = () => page.evaluate(() => Date.now());

  const { exp, v } = await views(page, await now());
  assert.deepEqual(confirm({ screen: v.screen, tools: v.tools, log: v.log }), { agree: true });
  assert.equal(v.tools.phase, "focus");

  // Mismatch 1: the exported log loses the completion. The screen and the tools still agree with each other.
  const dropped = exp.events.filter((e) => !e.type.endsWith("task_completed.v1"));
  const m1 = confirm({ screen: v.screen, tools: v.tools, log: replay(dropped, await now()) });
  assert.deepEqual(m1, { agree: false, first: { field: "status of task #2", screen: "completed", tools: "completed", log: "open" } });

  // Mismatch 2: the screen is made to disagree, and a later field (phase) also disagrees. The earlier field is named.
  const screenView = structuredClone(v.screen);
  screenView.tasks[0].status = "completed";
  screenView.phase = "idle";
  const m2 = confirm({ screen: screenView, tools: v.tools, log: v.log });
  assert.equal(m2.first.field, "status of task #1");
  assert.deepEqual([m2.first.screen, m2.first.tools, m2.first.log], ["completed", "open", "open"]);

  // Mismatch 3: reorder in the log. Order is the first thing compared.
  const reordered = replay([exp.events[1], exp.events[0], ...exp.events.slice(2)], await now());
  assert.equal(confirm({ screen: v.screen, tools: v.tools, log: reordered }).first.field, "task ids and order");

  // Mismatch 4, on the real page: the DOM status of one row is changed after rendering.
  await page.evaluate(() => { document.querySelector("li[data-task-id='t3']").dataset.status = "completed"; });
  const live = await views(page, await now());
  const m4 = confirm(live.v);
  assert.equal(m4.agree, false);
  assert.equal(m4.first.field, "status of task #3");
  assert.deepEqual([m4.first.screen, m4.first.tools, m4.first.log], ["completed", "open", "open"]);
  await context.close();
});

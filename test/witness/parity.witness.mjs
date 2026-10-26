// Interface-level witnesses for TANDEM-FUNC-PARITY-1..3. A person is the page controls. An agent is document.modelContext
// (getTools, executeTool). Nothing here imports an application module.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AGENT, click, serve, launch, openSession, importTasks, exportLog, events, screen } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const THREE = { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "One" }, { id: "t2", title: "Two", estimate_pomodoros: 2 }, { id: "t3", title: "Three", notes: "n" }] };

/** The agent's only path: discover the registry, then execute a registered tool by its descriptor. */
const tool = (page, name, input) => page.evaluate(async ([n, i]) => {
  const t = (await document.modelContext.getTools()).find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return JSON.parse(await document.modelContext.executeTool(t, i));
}, [name, { actor: AGENT, ...(input ?? {}) }]);
const registry = (page) => page.evaluate(async () => (await document.modelContext.getTools()).map((t) => t.name).sort());
const controls = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll("[data-command]")].map((e) => e.dataset.command))].sort());

test("TANDEM-FUNC-PARITY-1: controls, tools, and the registry are one set; pomodoro_finished is in none", async () => {
  const { context, page } = await openSession(browser, server.url);
  await importTasks(page, { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "One" }] }); // start/complete controls exist only with an open task
  const person = await controls(page);
  const agent = await registry(page);
  assert.equal(person.length, 11);
  assert.ok(person.includes("import_events"));
  assert.equal(agent.includes("import_events"), false);
  assert.equal(person.includes("wipe"), false);
  assert.equal(agent.includes("wipe"), false);
  assert.deepEqual(person.filter((n) => n !== "import_events"), agent);
  assert.match(await page.textContent("#status"), /11 commands declared/);
  for (const n of [...person, ...agent]) assert.doesNotMatch(n, /finish/);
  // The tool path: each registered tool carries a description and an input schema.
  const metas = await page.evaluate(async () => (await document.modelContext.getTools()).map((t) => [t.name, !!t.description, typeof t.inputSchema]));
  for (const [n, d, s] of metas) { assert.ok(d, n); assert.equal(s, "object", n); }
  // Calling the finish by name is not possible: it is not registered.
  await assert.rejects(tool(page, "pomodoro_finished"), /no tool/);
  await assert.rejects(tool(page, "pomodoro.finished"), /no tool/);
  await context.close();
});

/** Mask id, time, actor; rename each ULID by first sight so the shape of references survives. */
function mask(jsonl) {
  const seen = new Map();
  const m = (v) => (typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v) ? (seen.has(v) ? seen.get(v) : (seen.set(v, `<id${seen.size + 1}>`), seen.get(v))) : v);
  return events(jsonl).map((e) => ({
    type: e.type, subject: m(e.subject), source: e.source, specversion: e.specversion, dataschema: e.dataschema,
    data: Object.fromEntries(Object.entries(e.data).map(([k, v]) => [k, m(v)])),
  }));
}

test("TANDEM-FUNC-PARITY-2: import 3, start, stop, complete: person and agent leave the same domain facts", async () => {
  const p = await openSession(browser, server.url);
  await importTasks(p.page, THREE);
  await click(p.page, "li[data-task-id='t1'] [data-command='start_pomodoro']");
  await click(p.page, "[data-command='stop_pomodoro']");
  await click(p.page, "li[data-task-id='t1'] [data-command='complete_task']");
  const personLog = await exportLog(p.page);
  const personScreen = await screen(p.page);

  const a = await openSession(browser, server.url);
  const imp = await tool(a.page, "import_tasks", THREE);
  assert.equal(imp.accepted, 3);
  const started = await tool(a.page, "start_pomodoro", { task_id: "t1" });
  assert.equal(started.ok, true);
  assert.equal((await tool(a.page, "stop_pomodoro")).pomodoro_id, started.pomodoro_id);
  assert.equal((await tool(a.page, "complete_task", { task_id: "t1" })).ok, true);
  const agentLog = (await tool(a.page, "export_events")).events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const agentScreen = await screen(a.page);

  // The tool result and the exported file agree, and the screen shows what the tools did.
  const downloaded = await exportLog(a.page);
  assert.equal(downloaded.split("\n").slice(1).join("\n"), agentLog);
  assert.deepEqual(agentScreen, { ...personScreen, tasks: agentScreen.tasks, result: agentScreen.result });
  assert.deepEqual(agentScreen.tasks.map((t) => [t.id, t.status]), personScreen.tasks.map((t) => [t.id, t.status]));
  assert.deepEqual(agentScreen.tasks.map((t) => t.status), ["completed", "open", "open"]);
  assert.equal(agentScreen.status.phase, "idle");

  assert.deepEqual(mask(agentLog), mask(personLog));
  assert.equal(events(personLog).length, 6);
  // The only difference is who acted.
  assert.deepEqual([...new Set(events(personLog).map((e) => JSON.stringify(e.actor)))], [JSON.stringify({ kind: "human", name: "You" })]);
  assert.deepEqual([...new Set(events(agentLog).map((e) => JSON.stringify(e.actor)))], [JSON.stringify({ kind: "agent", name: "Agent" })]);
  assert.equal((await tool(a.page, "list_tasks", { status: "open" })).tasks.length, 2);
  await p.context.close(); await a.context.close();
});

test("TANDEM-FUNC-PARITY-3: the same invalid input gives the same code and adds no log event, by control and by tool", async () => {
  const p = await openSession(browser, server.url);
  const a = await openSession(browser, server.url);
  const ONE = { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "One" }] };
  await importTasks(p.page, ONE);
  await tool(a.page, "import_tasks", ONE);
  await click(p.page, "li[data-task-id='t1'] [data-command='start_pomodoro']");
  await tool(a.page, "start_pomodoro", { task_id: "t1" });

  // Chromium throttles repeated automatic downloads, so the person's log is downloaded once per step and the agent's log is read by its tool.
  const agentLog = async () => (await tool(a.page, "export_events")).events.map((e) => JSON.stringify(e)).join("\n");
  const logs = async () => [await exportLog(p.page), await agentLog()];
  const tag = (r) => (r.ok === false ? r.code : r.rejected.map((x) => `${x.code} at ${x.path}`).join("\n"));
  const cases = [
    ["add_task", "missing_title",
      async () => { await p.page.fill("#add-title", ""); await click(p.page, "[data-command='add_task']"); }, { title: "  " }],
    ["import_tasks wrong schema", "unsupported_schema",
      () => importTasks(p.page, { schema: "nope", tasks: [] }), { schema: "nope", tasks: [] }],
    ["import_tasks not a list", "invalid_payload",
      () => importTasks(p.page, { schema: "tandem.tasks/v0", tasks: "x" }), { schema: "tandem.tasks/v0", tasks: "x" }],
    ["import_tasks bad row", "missing_title at tasks[0].title",
      () => importTasks(p.page, { schema: "tandem.tasks/v0", tasks: [{ id: "x" }] }), { schema: "tandem.tasks/v0", tasks: [{ id: "x" }] }],
    ["start_pomodoro while running", "pomodoro_already_running",
      () => click(p.page, "li[data-task-id='t1'] [data-command='start_pomodoro']"), { task_id: "t1" }],
  ];
  const toolName = (c) => c.split(" ")[0];
  let before = await logs();
  for (const [label, code, byControl, input] of cases) {
    await byControl();
    const shown = (await screen(p.page)).rejection;
    const result = await tool(a.page, toolName(label), input);
    assert.equal(shown, code, `${label}: screen`);
    assert.equal(tag(result), code, `${label}: tool`);
    const afterLogs = await logs();
    assert.deepEqual(afterLogs, before, `${label}: no event added`);
    before = afterLogs;
  }

  // No pomodoro running: stop is rejected the same way from both.
  await click(p.page, "[data-command='stop_pomodoro']");
  await tool(a.page, "stop_pomodoro");
  before = await logs();
  await click(p.page, "[data-command='stop_pomodoro']");
  assert.equal((await screen(p.page)).rejection, "no_running_pomodoro");
  assert.deepEqual(await tool(a.page, "stop_pomodoro"), { ok: false, code: "no_running_pomodoro" });
  assert.deepEqual(await logs(), before);
  // A tool reaches rejections no control can: an unknown id.
  assert.deepEqual(await tool(a.page, "complete_task", { task_id: "nope" }), { ok: false, code: "unknown_task" });
  assert.deepEqual(await logs(), before);
  await p.context.close(); await a.context.close();
});

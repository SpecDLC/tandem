// Interface witness for import on the actor-object log.
// The page Import control is the only import path. Import stores each actor as written and adds no event type.
// One event that fails the structural check rejects the file. The import note stays on the page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AGENT, serve, launch, openSession, importTasks, exportLog, events, screen, click } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); server?.close(); });

const tool = (page, name, input) => page.evaluate(async ([n, i]) => {
  const t = (await document.modelContext.getTools()).find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return JSON.parse(await document.modelContext.executeTool(t, i));
}, [name, { actor: AGENT, ...(input ?? {}) }]);

const PAYLOAD = {
  schema: "tandem.tasks/v0",
  tasks: [
    { id: "t1", title: "Draft spec intro", estimate_pomodoros: 2 },
    { id: "t2", title: "Review cards" },
  ],
};

test("rule 1: import appends the event with the actor already stored on it", async () => {
  const a = await openSession(browser, server.url);
  const added = await tool(a.page, "add_task", { title: "From the agent" });
  assert.ok(added.task_id, JSON.stringify(added));
  const before = events(await exportLog(a.page));
  assert.equal(before.length, 1);
  assert.deepEqual(before[0].actor, AGENT);

  const b = await openSession(browser, server.url);
  await b.page.fill("#events-input", JSON.stringify(before[0]));
  await click(b.page, "[data-command='import_events']");
  const kept = events(await exportLog(b.page)).find((e) => e.id === before[0].id);
  assert.ok(kept, "imported event is in the log");
  assert.equal(JSON.stringify(kept), JSON.stringify(before[0]));
  assert.deepEqual(kept.actor, AGENT);
  await a.context.close();
  await b.context.close();
});

test("an actor is stored as written, including a legacy remote string", async () => {
  const a = await openSession(browser, server.url);
  await importTasks(a.page, PAYLOAD);
  const sample = events(await exportLog(a.page))[0];
  const foreign = { ...sample, id: "FOREIGNACTOR00000000000001", actor: "human:remote" };

  const b = await openSession(browser, server.url);
  await b.page.fill("#events-input", JSON.stringify(foreign));
  await click(b.page, "[data-command='import_events']");
  const view = await screen(b.page);
  assert.match(view.result, /imported 1, rejected 0, skipped 0/);
  assert.match(view.result, /Imported 1 event\./);
  const log = events(await exportLog(b.page));
  assert.equal(log.length, 1);
  assert.equal(JSON.stringify(log[0]), JSON.stringify(foreign));
  assert.equal(log[0].actor, "human:remote");
  await a.context.close();
  await b.context.close();
});

test("one bad event rejects the whole file and writes nothing", async () => {
  const a = await openSession(browser, server.url);
  await importTasks(a.page, PAYLOAD);
  const sample = events(await exportLog(a.page))[0];
  const good = { ...sample, id: "GOODPEER000000000000000001" };
  const bad = { ...sample, id: "BADTYPE0000000000000000001", type: "com.specdlc.tandem.note_added.v1" };

  const b = await openSession(browser, server.url);
  await b.page.fill("#events-input", `${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`);
  await click(b.page, "[data-command='import_events']");
  const view = await screen(b.page);
  assert.match(view.rejection, /invalid_events/);
  assert.equal(events(await exportLog(b.page)).length, 0);
  assert.equal(await b.page.locator("[data-import-note]").count(), 0);
  await a.context.close();
  await b.context.close();
});

test("rule 4: import_events is not a WebMCP tool; the page Import control remains", async () => {
  const a = await openSession(browser, server.url);
  const names = await a.page.evaluate(async () => (await document.modelContext.getTools()).map((t) => t.name));
  assert.equal(names.includes("import_events"), false, names.join(","));
  assert.equal(names.includes("add_task"), true);
  assert.equal(await a.page.locator("[data-command='import_events']").count(), 1);
  await a.context.close();
});

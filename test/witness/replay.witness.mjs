// Interface-level witness for TANDEM-ENG-1: export, wipe, import gives the same board; a second import changes nothing;
// every actor in the log comes from the button channel (human:local) or the WebMCP channel (agent:local).
// "Wipe" is a fresh browser context (empty local storage). An in-app wipe control does not exist yet; see ac/TANDEM-ENG-1.md.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, launch, openSession, importTasks, exportLog, events, screen, click } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const tool = (page, name, input) => page.evaluate(async ([n, i]) => {
  const t = (await document.modelContext.getTools()).find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return JSON.parse(await document.modelContext.executeTool(t, i));
}, [name, input ?? {}]);

const board = (s) => s.tasks.map((t) => `${t.id}|${t.status}|${t.text.replace(/\s+/g, " ")}`);

test("TANDEM-ENG-1: export, wipe, import yields the same board and log; a second import changes nothing", async () => {
  const a = await openSession(browser, server.url);
  await importTasks(a.page, { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "Draft spec intro", estimate_pomodoros: 2 }, { id: "t2", title: "Review cards" }] });
  const added = await tool(a.page, "add_task", { title: "Write guide" });
  assert.ok(added.task_id, JSON.stringify(added));
  await tool(a.page, "complete_task", { task_id: "t2" });
  const logA = await exportLog(a.page);
  const boardA = board(await screen(a.page));
  await a.context.close();

  const evs = events(logA);
  assert.ok(evs.length >= 4);
  const actors = new Set(evs.map((e) => e.actor));
  assert.ok(actors.has("human:local") && actors.has("agent:local"), [...actors].join(","));
  for (const a of actors) assert.match(a, /^(human|agent):local$/, `actor ${a} is not the button or WebMCP channel`);

  const b = await openSession(browser, server.url); // wiped: empty working copy
  assert.deepEqual(board(await screen(b.page)), []);
  const first = await tool(b.page, "import_events", { events: evs });
  assert.equal(first.imported, evs.length, JSON.stringify(first));
  await b.page.reload();
  await b.page.waitForSelector("#status[data-ready='true']", { state: "attached" });
  assert.deepEqual(board(await screen(b.page)), boardA);
  const logB = await exportLog(b.page);
  assert.equal(logB, logA);

  const second = await tool(b.page, "import_events", { events: evs });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped.length, evs.length);
  assert.equal(await exportLog(b.page), logA);
  assert.deepEqual(board(await screen(b.page)), boardA);
  await b.context.close();
});

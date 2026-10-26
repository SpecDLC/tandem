import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { click, serve, launch, openSession, importTasks, exportLog, events, screen } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const PAYLOAD = { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "Draft spec intro", estimate_pomodoros: 2 }, { id: "t2", title: "Review cards" }, { id: "t3", title: "Write guide" }] };

async function drive(page) {
  await importTasks(page, PAYLOAD);
  await page.fill("#add-title", "Added by hand");
  await click(page, "[data-command='add_task']");
  await click(page, "input[data-command='complete_task'][data-task-id='t2']");
  await click(page, "li[data-task-id='t1'] [data-command='start_pomodoro']");
}

test("TANDEM-TECH-LOG-1: export, discard the working copy, import the export: list and status match", async () => {
  const a = await openSession(browser, server.url);
  await drive(a.page);
  const listBefore = await screen(a.page);
  const exported = await exportLog(a.page);
  assert.equal(events(exported).length, 6);
  assert.equal(listBefore.status.phase, "focus");

  // A reload keeps the working copy.
  await a.page.reload();
  await a.page.waitForSelector("#status[data-ready='true']", { state: "attached" });
  assert.equal(await exportLog(a.page), exported);

  // A fresh context has no working copy. Import the export through the page.
  const b = await openSession(browser, server.url);
  assert.equal((await screen(b.page)).tasks.length, 0);
  await b.page.fill("#events-input", exported);
  await click(b.page, "[data-command='import_events']");
  const listAfter = await screen(b.page);
  assert.match(listAfter.result, /imported 6, rejected 0, skipped 0/);
  assert.match(listAfter.result, /Imported 6 events\./);
  assert.deepEqual(listAfter.tasks, listBefore.tasks);
  assert.deepEqual(listAfter.status, listBefore.status);
  const afterLog = await exportLog(b.page);
  assert.equal(afterLog, exported, "imported events keep their bytes and add no event");
  assert.equal(events(afterLog).some((e) => String(e.type).endsWith("log_imported.v1")), false);

  // Importing the same events again adds nothing.
  await click(b.page, "[data-command='import_events']");
  const second = await screen(b.page);
  assert.match(second.result, /imported 0, rejected 0, skipped 6/);
  assert.match(second.result, /Imported 0 events\./);
  assert.equal(await exportLog(b.page), afterLog);
  await a.context.close();
  await b.context.close();
});

test("TANDEM-TECH-LOG-2: an export is a byte prefix of the export after another command", async () => {
  const { context, page } = await openSession(browser, server.url);
  await importTasks(page, PAYLOAD);
  let previous = await exportLog(page);
  assert.ok(previous.length > 0 && previous.endsWith("\n"));
  const steps = [
    () => click(page, "input[data-command='complete_task'][data-task-id='t3']"),
    () => click(page, "li[data-task-id='t1'] [data-command='start_pomodoro']"),
    () => click(page, "[data-command='stop_pomodoro']"),
    () => click(page, "[data-command='stop_pomodoro']"), // a rejection adds nothing
  ];
  for (const step of steps) {
    await step();
    const next = await exportLog(page);
    assert.ok(next.startsWith(previous), "earlier bytes are unchanged");
    previous = next;
  }
  assert.equal(events(previous).length, 6);
  await context.close();
});

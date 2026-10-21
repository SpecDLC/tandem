import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { click, serve, launch, openSession, importTasks, exportLog, events, screen, T0 } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const ONE = { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "Focus on the draft" }] };
const types = (jsonl) => events(jsonl).map((e) => e.type.replace("com.specdlc.tandem.", ""));

test("TANDEM-FUNC-TIMER-1: start, start again (rejected), reach the end: one pomodoro_finished, then break", async () => {
  const { context, page } = await openSession(browser, server.url);
  await importTasks(page, ONE);
  await click(page, "[data-command='start_pomodoro']");
  let s = await screen(page);
  assert.equal(s.status.phase, "focus");
  assert.equal(s.status.remaining, 1500);
  assert.match(s.status.text, /Focus on the draft/);

  // The same task's Start. Start next is hidden while a timer runs, and it is a different control.
  await click(page, "li[data-task-id='t1'] [data-command='start_pomodoro']");
  s = await screen(page);
  assert.equal(s.rejection, "pomodoro_already_running");
  const running = await exportLog(page);
  assert.deepEqual(types(running), ["task_imported.v1", "pomodoro_started.v1"]);
  const started = events(running)[1];
  assert.equal(started.data.focus_seconds, 1500);
  assert.equal(started.data.break_seconds, 300);
  assert.equal(started.data.ends_at, new Date(T0 + 1000 + 1500_000).toISOString());

  await page.clock.fastForward(1499_000);
  assert.equal((await screen(page)).status.phase, "focus");
  assert.equal(types(await exportLog(page)).includes("pomodoro_finished.v1"), false);

  await page.clock.fastForward(2_000);
  await page.waitForFunction(() => document.querySelector("[data-command='get_status']").dataset.phase === "break");
  s = await screen(page);
  assert.ok(s.status.remaining > 295 && s.status.remaining <= 300, `break remaining ${s.status.remaining}`);
  const finished = events(await exportLog(page)).filter((e) => e.type.endsWith("pomodoro_finished.v1"));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].time, started.data.ends_at);
  assert.equal(finished[0].data.pomodoro_id, started.data.pomodoro_id);

  await page.clock.fastForward(60_000);
  assert.equal(events(await exportLog(page)).filter((e) => e.type.endsWith("pomodoro_finished.v1")).length, 1);

  await page.clock.fastForward(300_000);
  await page.waitForFunction(() => document.querySelector("[data-command='get_status']").dataset.phase === "idle");
  assert.equal((await screen(page)).status.remaining, 0);
  assert.equal(events(await exportLog(page)).filter((e) => e.type.endsWith("pomodoro_finished.v1")).length, 1);
  await context.close();
});

test("TANDEM-FUNC-TIMER-1: stop while idle is rejected and writes nothing; stop while running returns to idle", async () => {
  const { context, page } = await openSession(browser, server.url);
  await importTasks(page, ONE);
  const before = await exportLog(page);
  await click(page, "[data-command='stop_pomodoro']");
  assert.equal((await screen(page)).rejection, "no_running_pomodoro");
  assert.equal(await exportLog(page), before);
  await click(page, "[data-command='start_pomodoro']");
  await click(page, "[data-command='stop_pomodoro']");
  const s = await screen(page);
  assert.equal(s.status.phase, "idle");
  assert.equal(s.rejection, "");
  assert.deepEqual(types(await exportLog(page)), ["task_imported.v1", "pomodoro_started.v1", "pomodoro_stopped.v1"]);
  await context.close();
});

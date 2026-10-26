// Page witnesses for the seven acceptance checks. The page is the interface.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { click, serve, launch, openSession, exportLog, events, screen } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const TEXIAN = { kind: "agent", name: "Texian" };
const tool = (page, name, input) => page.evaluate(async ([n, i]) => {
  const t = (await document.modelContext.getTools()).find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return JSON.parse(await document.modelContext.executeTool(t, i));
}, [name, input]);

const activity = (page) => page.locator("[data-field='activity'] li").first().evaluate((li) => ({
  who: li.querySelector(".who")?.textContent ?? "",
  text: (li.querySelector(".who")?.nextElementSibling?.textContent ?? "").replace(/\s+/g, " ").trim(),
}));

test("the page shows the actor name, a 22 minute focus, a default of 25, and a format header", async () => {
  const { context, page } = await openSession(browser, server.url);
  const off = [];
  page.on("request", (req) => { if (!req.url().startsWith(server.url)) off.push(req.url()); });

  const reach = await page.evaluate(async () => ({
    same: navigator.modelContext === document.modelContext,
    names: typeof navigator.modelContext?.getTools === "function"
      ? (await navigator.modelContext.getTools()).map((t) => t.name).sort()
      : [],
  }));
  assert.equal(reach.same, true);
  assert.ok(reach.names.includes("start_pomodoro"));
  assert.equal(reach.names.includes("pomodoro_finished"), false);

  await tool(page, "add_task", { actor: TEXIAN, title: "Draft" });
  const row = await activity(page);
  assert.equal(row.who, "Texian");
  assert.match(row.text, /Texian added “Draft”/);

  const started = await tool(page, "start_pomodoro", { actor: TEXIAN, task_id: (await screen(page)).tasks[0].id, minutes: 22 });
  assert.equal(started.minutes, 22);
  assert.equal(await page.locator("[data-field='clock']").innerText(), "22:00");
  assert.match(await page.locator("[data-field='elapsed']").innerText(), /of 22 min/i);
  assert.equal(await page.locator("[data-field='actor']").evaluate((el) => el.textContent), "Texian");
  const running = events(await exportLog(page)).find((e) => e.type.endsWith("pomodoro_started.v1"));
  assert.equal(running.data.minutes, 22);
  assert.equal(running.data.focus_seconds, 1320);

  await click(page, "[data-command='stop_pomodoro']");
  const plain = await tool(page, "start_pomodoro", { actor: TEXIAN, task_id: (await screen(page)).tasks[0].id });
  assert.equal(plain.minutes, 25);
  const second = events(await exportLog(page)).filter((e) => e.type.endsWith("pomodoro_started.v1")).at(-1);
  assert.equal(second.data.minutes, 25);
  assert.equal(second.data.focus_seconds, 1500);
  const file = await exportLog(page);
  const header = JSON.parse(file.split("\n")[0]);
  assert.deepEqual(header, { format: "tandem.session-log", version: 1 });
  assert.deepEqual([...new Set(events(file).map((e) => e.type))].filter((t) => !t.startsWith("com.specdlc.tandem.")), []);
  assert.deepEqual(off, []);
  await context.close();
});

test("a pre-change file replays as unknown actor and 25 minutes; a bad file imports nothing", async () => {
  const { context, page } = await openSession(browser, server.url);
  const off = [];
  page.on("request", (req) => { if (!req.url().startsWith(server.url)) off.push(req.url()); });
  const oldTask = {
    specversion: "1.0", id: "01OLD0000000000000000001", source: "urn:specdlc:tandem",
    type: "com.specdlc.tandem.task_added.v1", subject: "old", time: "2026-10-14T12:00:01.000Z",
    datacontenttype: "application/json", dataschema: "urn:specdlc:schema:tandem.session:1",
    actor: "human:local", data: { task_id: "old", title: "Old task" },
  };
  const oldStart = {
    specversion: "1.0", id: "01OLD0000000000000000002", source: "urn:specdlc:tandem",
    type: "com.specdlc.tandem.pomodoro_started.v1", subject: "old-p", time: "2026-10-14T12:00:01.000Z",
    datacontenttype: "application/json", dataschema: "urn:specdlc:schema:tandem.session:1",
    actor: "agent:local",
    data: { pomodoro_id: "old-p", task_id: "old", focus_seconds: 1500, break_seconds: 300, ends_at: "2026-10-14T12:25:01.000Z" },
  };
  const legacy = `${JSON.stringify(oldTask)}\n${JSON.stringify(oldStart)}\n`;
  await page.fill("#events-input", legacy);
  await click(page, "[data-command='import_events']");
  assert.match((await screen(page)).result, /imported 2, rejected 0, skipped 0/);
  const row = await activity(page);
  assert.equal(row.who, "unknown actor");
  assert.match(row.text, /unknown actor started focus on “Old task”/);
  assert.equal(await page.locator("[data-field='clock']").innerText(), "25:00");
  assert.match(await page.locator("[data-field='elapsed']").innerText(), /of 25 min/i);
  const replayed = events(await exportLog(page));
  assert.equal(replayed[1].actor, "agent:local");
  assert.equal("minutes" in replayed[1].data, false);

  const fresh = await openSession(browser, server.url);
  fresh.page.on("request", (req) => { if (!req.url().startsWith(server.url)) off.push(req.url()); });
  await fresh.page.fill("#events-input", `${JSON.stringify(oldTask)}\nthis is not an event\n`);
  await click(fresh.page, "[data-command='import_events']");
  assert.equal((await screen(fresh.page)).rejection, "invalid_events");
  assert.equal((await screen(fresh.page)).tasks.length, 0);
  assert.equal(events(await exportLog(fresh.page)).length, 0);
  assert.deepEqual(off, []);
  await context.close();
  await fresh.context.close();
});

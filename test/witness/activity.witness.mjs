// Activity strip and agent attribution. The page is the only interface: controls, tools, and the exported log.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AGENT, click, serve, launch, openSession, exportLog, events, screen } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const tool = (page, name, input) => page.evaluate(async ([n, i]) => {
  const t = (await document.modelContext.getTools()).find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return JSON.parse(await document.modelContext.executeTool(t, i));
}, [name, { actor: AGENT, ...(input ?? {}) }]);

const presenceOf = (page) => page.locator(".presence").evaluate((el) => ({
  state: el.getAttribute("data-state"),
  tool: el.querySelector("code")?.textContent ?? "",
  text: el.querySelector("[data-field='presence']")?.textContent ?? "",
}));

const activityOf = (page) => page.locator("[data-field='activity'] li").evaluateAll((els) => els.map((li) => ({
  who: li.querySelector(".who")?.textContent ?? "",
  actor: li.querySelector(".who")?.getAttribute("data-actor") ?? "",
  text: (li.querySelector(".who")?.nextElementSibling?.textContent ?? "").replace(/\s+/g, " ").trim(),
})));

const touched = (page, selector) => page.locator(selector).evaluate((el) => ({
  touched: el.getAttribute("data-touched") ?? "",
  tool: el.getAttribute("data-touched-tool") ?? "",
}));

test("agent tools mark the changed element and the masthead; a human action marks nothing", async () => {
  const { context, page } = await openSession(browser, server.url);
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.match(await page.textContent("#status"), /11 commands declared/);

  const looking = await tool(page, "list_tasks");
  assert.equal(looking.ok, true);
  assert.deepEqual(await presenceOf(page), { state: "active", tool: "list_tasks", text: "Agent · list_tasks" });
  assert.equal(await page.locator("[data-touched='agent']").count(), 0);

  await page.fill("#add-title", "Human task");
  await click(page, "[data-command='add_task']");
  const humanId = await page.locator("li.task", { hasText: "Human task" }).getAttribute("data-task-id");
  assert.ok(humanId);
  assert.deepEqual(await touched(page, `li[data-task-id="${humanId}"] .task__front`), { touched: "", tool: "" });
  assert.equal((await presenceOf(page)).tool, "list_tasks");
  const afterHuman = await activityOf(page);
  assert.equal(afterHuman[0].who, "You");
  assert.equal(afterHuman[0].actor, "human");
  assert.match(afterHuman[0].text, /You added “Human task”/);

  await click(page, `li[data-task-id="${humanId}"] [data-command='start_pomodoro']`);
  await click(page, "[data-command='stop_pomodoro']");
  assert.notEqual((await touched(page, ".focus")).tool, "stop_pomodoro");
  assert.notEqual((await touched(page, ".focus")).touched, "agent");
  assert.equal((await presenceOf(page)).tool, "list_tasks");

  const a1 = await tool(page, "add_task", { title: "A1" });
  const a2 = await tool(page, "add_task", { title: "A2" });
  const a3 = await tool(page, "add_task", { title: "A3" });
  assert.equal(a1.ok, true);
  assert.deepEqual(await touched(page, `li[data-task-id="${a1.task_id}"] .task__front`), { touched: "agent", tool: "add_task" });
  assert.deepEqual(await touched(page, `li[data-task-id="${humanId}"] .task__front`), { touched: "", tool: "" });
  assert.equal((await page.locator(`li[data-task-id="${humanId}"] .actor`).textContent())?.trim(), "You");
  assert.equal((await page.locator(`li[data-task-id="${a1.task_id}"] .actor`).textContent())?.trim(), "Agent");

  const started = await tool(page, "start_pomodoro", { task_id: a1.task_id });
  assert.equal(started.ok, true);
  assert.deepEqual(await touched(page, ".focus"), { touched: "agent", tool: "start_pomodoro" });
  assert.deepEqual(await presenceOf(page), { state: "active", tool: "start_pomodoro", text: "Agent · start_pomodoro" });
  assert.equal((await page.locator("[data-field='actor']").textContent())?.trim(), "Agent");
  assert.equal(await page.locator("[data-field='actor']").getAttribute("data-actor"), "agent");

  const rows = await activityOf(page);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.who), ["Agent", "Agent", "Agent", "Agent"]);
  assert.match(rows[0].text, /Agent started focus on “A1”/);
  assert.match(rows[1].text, /Agent added “A3”/);
  assert.match(rows[2].text, /Agent added “A2”/);
  assert.match(rows[3].text, /Agent added “A1”/);
  assert.ok(rows.every((row) => row.actor === "agent" && !row.text.includes(":local")));

  await tool(page, "get_status");
  assert.equal((await presenceOf(page)).tool, "get_status");
  assert.equal((await touched(page, ".focus")).tool, "start_pomodoro");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".ticker").isVisible(), true);
  assert.equal(await page.locator(".activity-panel").isVisible(), false);
  assert.equal((await page.locator("[data-field='ticker-who']").textContent())?.trim(), "Agent");
  assert.match(await page.locator("[data-field='ticker-text']").innerText(), /Agent started focus on “A1”/);
  assert.equal(await page.locator("[data-field='ticker-rest'] li").count(), 3);

  const before = await activityOf(page);
  const board = await screen(page);
  const log = await exportLog(page);
  const evs = events(log);
  assert.ok(evs.some((e) => e.actor?.kind === "human" && e.actor?.name === "You"));
  assert.ok(evs.some((e) => e.actor?.kind === "agent" && e.actor?.name === "Agent"));
  assert.ok(evs.every((e) => (e.actor?.name === "You" && e.actor?.kind === "human") || (e.actor?.name === "Agent" && e.actor?.kind === "agent")));
  assert.ok(!log.includes('"actor":"Agent"') && !log.includes('"actor":"You"'));

  const replay = await openSession(browser, server.url);
  await replay.page.fill("#events-input", log);
  await click(replay.page, "[data-command='import_events']");
  assert.deepEqual(await activityOf(replay.page), before);
  assert.deepEqual((await screen(replay.page)).tasks, board.tasks);
  assert.deepEqual((await screen(replay.page)).status, board.status);
  assert.equal(await replay.page.locator("[data-touched='agent']").count(), 0);
  assert.equal((await replay.page.locator("[data-field='actor']").textContent())?.trim(), "Agent");
  assert.match((await screen(replay.page)).result, /Imported \d+ events\./);
  const replayed = await exportLog(replay.page);
  assert.equal(replayed, log);
  assert.equal(events(replayed).some((e) => String(e.type).endsWith("log_imported.v1")), false);
  assert.equal(a2.ok && a3.ok, true);
  await context.close();
  await replay.context.close();
});

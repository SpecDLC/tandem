import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { click, serve, launch, openSession, importTasks, exportLog, events, screen } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const FIXTURE = {
  schema: "tandem.tasks/v0",
  tasks: [
    { id: "t1", title: "Draft spec intro", estimate_pomodoros: 2 },
    { id: "t2", title: "Review cards", notes: "before Friday" },
    { title: "Write guide" },
    { id: "t4" },
    { id: "t1", title: "Duplicate of t1" },
    { id: "t5", title: "Has an unknown field", color: "red" },
  ],
};

test("TANDEM-FUNC-IMPORT-1: accepted 4, rejected 1 with a path, skipped 1; unknown field reported, not stored", async () => {
  const { context, page } = await openSession(browser, server.url);
  await importTasks(page, FIXTURE);
  const s = await screen(page);
  assert.match(s.result, /accepted 4, rejected 1, skipped 1/);
  assert.match(s.rejection, /missing_title at tasks\[3\]\.title/);
  assert.match(s.result, /skipped t1: duplicate_id/);
  assert.match(s.result, /ignored field tasks\[5\]\.color/);
  assert.deepEqual(s.tasks.map((t) => t.text.replace(/\s+/g, " ")).map((t) => t.replace(/ Start$/, "")),
    ["Draft spec intro 2 pomodoros", "Review cards before Friday", "Write guide", "Has an unknown field"]);
  assert.equal(s.tasks[0].id, "t1");
  assert.ok(!s.tasks.some((t) => /Duplicate|color|red/.test(t.text)));
  const log = await exportLog(page);
  const evs = events(log);
  assert.equal(evs.length, 4);
  assert.ok(evs.every((e) => e.type === "com.specdlc.tandem.task_imported.v1"));
  assert.ok(!log.includes("color"));
  assert.ok(!log.includes("Duplicate of t1"));
  await context.close();
});

test("TANDEM-FUNC-IMPORT-2: a wrong or missing schema returns unsupported_schema and writes nothing", async () => {
  const { context, page } = await openSession(browser, server.url);
  await importTasks(page, { schema: "tandem.tasks/v0", tasks: [{ id: "keep", title: "Keep" }] });
  const before = await exportLog(page);
  for (const bad of [{ schema: "tandem.tasks/v1", tasks: [{ title: "x" }] }, { tasks: [{ title: "y" }] }, { schema: 3, tasks: [] }]) {
    await importTasks(page, bad);
    const s = await screen(page);
    assert.equal(s.rejection, "unsupported_schema");
    assert.equal(s.tasks.length, 1);
    assert.equal(await exportLog(page), before);
  }
  // A fresh session: the same rejection, and the file is a header with no events.
  const fresh = await openSession(browser, server.url);
  await importTasks(fresh.page, { schema: "wrong", tasks: [{ title: "z" }] });
  assert.equal((await screen(fresh.page)).rejection, "unsupported_schema");
  const empty = await exportLog(fresh.page);
  assert.equal(events(empty).length, 0);
  assert.deepEqual(JSON.parse(empty.split("\n")[0]), { format: "tandem.session-log", version: 1 });
  await fresh.context.close();
  await context.close();
});

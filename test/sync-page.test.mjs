// Acceptance checks 5–11 and 13–14. The page module runs against the in-memory reference endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { Session, bind } from "../src/registry.ts";
import { LOG_FORMAT, LOG_VERSION, MemoryStore, parseLogFile } from "../src/log.ts";
import {
  MemorySyncSettings, NEWER_VERSION, SYNC_BUSY, conflictLabel, findConflicts, invalidSeqMessage, syncHeaders, syncSession,
} from "../src/sync.ts";
import { startSyncEndpoint } from "./sync-endpoint.mjs";

const T0 = Date.parse("2026-10-14T18:00:00.000Z");
const PATRICK = { kind: "human", name: "Patrick" };
const TEXIAN = { kind: "agent", name: "Texian" };
const TASKS = (id, title) => ({ schema: "tandem.tasks/v0", tasks: [{ id, title }] });

function device(actor, t = T0) {
  const clock = { t };
  const store = new MemoryStore();
  const settings = new MemorySyncSettings();
  const session = new Session(store, () => clock.t);
  return {
    clock, store, settings, session,
    human: bind(session, actor),
    sync: (opts = {}) => syncSession({ session, store, settings, ...opts }),
  };
}

async function arm(page, endpoint, token = "", lastSeq = 0, knownIds = []) {
  await page.settings.save({ endpoint, token, lastSeq, knownIds });
}

async function withEndpoint(options, fn) {
  const ep = await startSyncEndpoint(options);
  try { return await fn(ep); }
  finally { await ep.close(); }
}

const remoteIds = async (ep) => {
  const body = await (await fetch(`${ep.url}/v1/events?since=0`)).json();
  return body.events.map((row) => row.event.id);
};

const post = (ep, body) => fetch(`${ep.url}/v1/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("5. the endpoint stores an unknown type, and catch-up imports nothing from that page", async () => {
  await withEndpoint({}, async (ep) => {
    const bad = {
      id: "bad-event",
      type: "com.specdlc.tandem.not_a_command.v1",
      actor: { kind: "nope", name: "" },
      data: { task_id: "t" },
    };
    const maker = device(PATRICK);
    await maker.human.add_task("Kept aside");
    const good = maker.session.exportEvents().events[0];
    const stored = await post(ep, { expected_next_seq: 1, events: [good, bad] });
    assert.equal(stored.status, 200);
    assert.deepEqual(await remoteIds(ep), [good.id, bad.id]);

    const page = device(TEXIAN);
    await arm(page, ep.url);
    const report = await page.sync();
    assert.equal(report.ok, false);
    assert.equal(report.code, "invalid_events");
    assert.equal(report.seq, 2);
    assert.equal(report.message, invalidSeqMessage(2));
    assert.deepEqual(await page.store.load(), []);
    assert.equal((await page.settings.load()).lastSeq, 0);
    assert.deepEqual(await remoteIds(ep), [good.id, bad.id]);
  });
});

test("6. seven commands append while the endpoint is down, then sync advances last_seq", async () => {
  await withEndpoint({}, async (ep) => {
    const closed = await startSyncEndpoint();
    const downUrl = closed.url;
    await closed.close();
    const page = device(PATRICK);
    await arm(page, downUrl);
    const down = await page.sync();
    assert.equal(down.code, "unreachable");

    const imported = await page.human.import_tasks(TASKS("t1", "Imported"));
    const added = await page.human.add_task("Added");
    const completed = await page.human.complete_task(added.task_id);
    const started = await page.human.start_pomodoro("t1");
    const paused = await page.human.pause_pomodoro();
    const resumed = await page.human.resume_pomodoro(started.pomodoro_id);
    const stopped = await page.human.stop_pomodoro();
    for (const result of [imported, added, completed, started, paused, resumed, stopped]) assert.equal(result.ok, true);
    const local = await page.store.load();
    assert.equal(local.length, 7);

    await arm(page, ep.url);
    const up = await page.sync();
    assert.equal(up.ok, true);
    assert.equal((await page.settings.load()).lastSeq, 7);
    assert.equal((await remoteIds(ep)).length, 7);
    assert.deepEqual(await page.store.load(), local);
  });
});

test("7. two devices converge on the same ids in either sync order", async () => {
  async function run(firstActor, secondActor) {
    await withEndpoint({}, async (ep) => {
      const a = device(firstActor, T0);
      const b = device(secondActor, T0 + 60_000);
      await arm(a, ep.url);
      await arm(b, ep.url);
      const left = await a.human.add_task("From A");
      const right = await b.human.add_task("From B");
      await a.sync();
      await b.sync();
      await a.sync();
      const ids = (session) => session.logEvents().map((event) => event.id).sort();
      const tasks = (session) => session.replayProjection().list().map((task) => task.task_id).sort();
      assert.deepEqual(ids(a.session), ids(b.session));
      assert.deepEqual(tasks(a.session), [left.task_id, right.task_id].sort());
      assert.deepEqual(tasks(b.session), tasks(a.session));
      assert.equal(new Set(await remoteIds(ep)).size, 2);
    });
  }
  await run(PATRICK, TEXIAN);
  await run(TEXIAN, PATRICK);
});

test("8. conflict flagged: both completions stay, and the mark names both actors and both times", async () => {
  await withEndpoint({}, async (ep) => {
    const a = device(PATRICK, T0);
    const b = device(TEXIAN, T0 + 5 * 60_000);
    await arm(a, ep.url);
    await arm(b, ep.url);
    await a.human.import_tasks(TASKS("T", "Shared"));
    await b.human.import_tasks(TASKS("T", "Shared"));
    await a.human.complete_task("T");
    await b.human.complete_task("T");
    const before = await a.store.load();
    await a.sync();
    await b.sync();
    await a.sync();
    const completions = (session) => session.logEvents().filter((event) => event.type.endsWith("task_completed.v1"));
    const aDone = completions(a.session);
    const bDone = completions(b.session);
    assert.equal(aDone.length, 2);
    assert.equal(bDone.length, 2);
    assert.deepEqual(aDone.map((event) => event.id).sort(), bDone.map((event) => event.id).sort());
    assert.deepEqual((await a.store.load()).slice(0, before.length), before);
    const mark = findConflicts(a.session.logEvents()).find((conflict) => conflict.taskId === "T");
    assert.ok(mark);
    const label = conflictLabel(mark);
    assert.match(label, /Patrick/);
    assert.match(label, /Texian/);
    assert.match(label, /2026-10-14T18:00:00.000Z/);
    assert.match(label, /2026-10-14T18:05:00.000Z/);
    assert.equal(a.session.replayProjection().task("T").status, "completed");
    assert.equal(b.session.replayProjection().task("T").status, "completed");
  });
});

test("a start on a task the other side completed is flagged for both devices", async () => {
  await withEndpoint({}, async (ep) => {
    const a = device(PATRICK, T0 + 60_000);
    const b = device(TEXIAN, T0);
    await arm(a, ep.url);
    await arm(b, ep.url);
    await a.human.import_tasks(TASKS("T", "Shared"));
    await b.human.import_tasks(TASKS("T", "Shared"));
    const started = await b.human.start_pomodoro("T");
    const completed = await a.human.complete_task("T");
    assert.equal(started.ok, true);
    assert.equal(completed.ok, true);
    await a.sync();
    await b.sync();
    await a.sync();
    for (const page of [a, b]) {
      const mark = (await page.settings.loadConflicts()).find((conflict) => conflict.taskId === "T");
      assert.ok(mark, "conflict mark saved");
      const label = conflictLabel(mark);
      assert.match(label, /Patrick/);
      assert.match(label, /Texian/);
      assert.match(label, new RegExp(a.session.logEvents().find((event) => event.type.endsWith("task_completed.v1")).time));
      assert.match(label, new RegExp(b.session.logEvents().find((event) => event.type.endsWith("pomodoro_started.v1")).time));
    }
  });
});

test("a local start then complete is not a conflict", async () => {
  const page = device(PATRICK);
  const added = await page.human.add_task("Solo");
  await page.human.start_pomodoro(added.task_id);
  await page.human.complete_task(added.task_id);
  assert.deepEqual(findConflicts(page.session.logEvents()), []);
});

test("9. a 409 re-reads and retries with no duplicate ids; five conflicts report sync busy", async () => {
  await withEndpoint({}, async (ep) => {
    const a = device(PATRICK, T0);
    const b = device(TEXIAN, T0 + 60_000);
    await arm(a, ep.url);
    await arm(b, ep.url);
    await a.human.add_task("From A");
    await b.human.add_task("From B");
    let interleaved = false;
    const report = await a.sync({
      beforePush: async () => {
        if (interleaved) return;
        interleaved = true;
        await b.sync();
      },
    });
    assert.equal(interleaved, true);
    assert.equal(report.ok, true);
    await b.sync();
    const ids = await remoteIds(ep);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 2);
    assert.deepEqual(a.session.logEvents().map((event) => event.id).sort(), b.session.logEvents().map((event) => event.id).sort());
  });

  await withEndpoint({}, async (ep) => {
    const a = device(PATRICK, T0);
    const c = device(TEXIAN, T0 + 60_000);
    await arm(a, ep.url);
    await arm(c, ep.url);
    const added = await a.human.add_task("Stuck");
    const ownId = a.session.exportEvents().events[0].id;
    let tries = 0;
    const report = await a.sync({
      beforePush: async () => {
        tries += 1;
        c.clock.t += 1000;
        await c.human.add_task(`Other ${tries}`);
        await c.sync();
      },
    });
    assert.equal(tries, 5);
    assert.equal(report.ok, false);
    assert.equal(report.code, "sync_busy");
    assert.equal(report.message, SYNC_BUSY);
    assert.equal((await remoteIds(ep)).includes(ownId), false);
    assert.equal(added.ok, true);
    assert.equal((await a.store.load()).some((line) => line.includes(ownId)), true);
  });
});

test("10. lines already in the local store stay byte-identical after sync", async () => {
  await withEndpoint({}, async (ep) => {
    const a = device(PATRICK, T0);
    const b = device(TEXIAN, T0 + 1000);
    await arm(a, ep.url);
    await arm(b, ep.url);
    await a.human.add_task("Remote");
    await a.sync();
    await b.human.add_task("Local");
    const before = await b.store.load();
    await b.sync();
    const after = await b.store.load();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.ok(after.length > before.length);
  });
});

test("11. Authorization is sent only to the configured origin, and only when a token is set", async () => {
  await withEndpoint({}, async (ep) => {
    const page = device(PATRICK);
    await arm(page, ep.url, "sekret");
    const seen = [];
    const spy = async (url, init) => {
      const headers = init?.headers ?? {};
      const key = Object.keys(headers).find((name) => name.toLowerCase() === "authorization");
      seen.push({ url: String(url), auth: key ? headers[key] : undefined });
      return fetch(url, init);
    };
    await page.sync({ fetchImpl: spy });
    assert.ok(seen.length >= 1);
    for (const call of seen) {
      assert.equal(new URL(call.url).origin, new URL(ep.url).origin);
      assert.equal(call.auth, "Bearer sekret");
      assert.equal(call.url.includes("sekret"), false);
    }
    assert.equal(syncHeaders("https://example.com/v1/info", ep.url, "sekret").authorization, undefined);
    assert.equal(syncHeaders(`${ep.url}/v1/info`, ep.url, "sekret").authorization, "Bearer sekret");

    seen.length = 0;
    await arm(page, ep.url, "");
    await page.sync({ fetchImpl: spy });
    assert.ok(seen.length >= 1);
    for (const call of seen) assert.equal(call.auth, undefined);
  });
});

test("turning sync off leaves the local log and the endpoint unchanged", async () => {
  await withEndpoint({}, async (ep) => {
    const page = device(PATRICK);
    await arm(page, ep.url);
    await page.human.add_task("Stay");
    await page.sync();
    const local = await page.store.load();
    const remote = await remoteIds(ep);
    await page.settings.turnOff();
    const off = await page.sync();
    assert.equal(off.code, "off");
    assert.deepEqual(await page.store.load(), local);
    assert.deepEqual(await remoteIds(ep), remote);
  });
});

const legacyFile = (header) => {
  const task = {
    specversion: "1.0", id: "01LEGACYTASK00000000000001", source: "urn:specdlc:tandem",
    type: "com.specdlc.tandem.task_added.v1", subject: "t-old", time: "2026-10-14T18:00:00.000Z",
    datacontenttype: "application/json", dataschema: "urn:specdlc:schema:tandem.session:1",
    actor: "human:local", data: { task_id: "t-old", title: "Old task" },
  };
  const start = {
    specversion: "1.0", id: "01LEGACYSTART0000000000001", source: "urn:specdlc:tandem",
    type: "com.specdlc.tandem.pomodoro_started.v1", subject: "p-old", time: "2026-10-14T18:00:00.000Z",
    datacontenttype: "application/json", dataschema: "urn:specdlc:schema:tandem.session:1",
    actor: "agent:local",
    data: { pomodoro_id: "p-old", task_id: "t-old", focus_seconds: 1500, break_seconds: 300, ends_at: "2026-10-14T18:25:00.000Z" },
  };
  const absent = {
    specversion: "1.0", id: "01LEGACYNONE0000000000001", source: "urn:specdlc:tandem",
    type: "com.specdlc.tandem.task_added.v1", subject: "t-none", time: "2026-10-14T18:00:01.000Z",
    datacontenttype: "application/json", dataschema: "urn:specdlc:schema:tandem.session:1",
    data: { task_id: "t-none", title: "No actor" },
  };
  const body = `${JSON.stringify(task)}\n${JSON.stringify(start)}\n${JSON.stringify(absent)}\n`;
  if (!header) return body;
  return `${JSON.stringify({ format: LOG_FORMAT, version: LOG_VERSION })}\n${body}`;
};

test("13. a pre-change export and a version 1 file push and read back byte-identical", async () => {
  for (const header of [false, true]) {
    await withEndpoint({}, async (ep) => {
      const parsed = parseLogFile(legacyFile(header));
      assert.equal(parsed.ok, true);
      const a = device(PATRICK);
      const imported = await a.session.importEvents(parsed.events);
      assert.equal(imported.imported, 3);
      const lines = await a.store.load();
      await arm(a, ep.url);
      assert.equal((await a.sync()).ok, true);
      assert.deepEqual(await a.store.load(), lines);

      const b = device(TEXIAN);
      await arm(b, ep.url);
      assert.equal((await b.sync()).ok, true);
      assert.deepEqual(await b.store.load(), lines);
      assert.equal(b.session.activity.newest(4).every((row) => row.name === "unknown actor"), true);
      assert.equal(b.session.getStatus().focus_minutes, 25);
      assert.equal(b.session.replayProjection().list().map((task) => task.task_id).sort().join(), "t-none,t-old");
    });
  }
});

test("14. version 2 or a 404 on /v1/ shows the newer-version message and sends nothing", async () => {
  await withEndpoint({ version: 2 }, async (ep) => {
    const page = device(PATRICK);
    await arm(page, ep.url, "sekret");
    await page.human.add_task("Local only");
    const seen = [];
    const report = await page.sync({
      fetchImpl: async (url, init) => { seen.push(String(url)); return fetch(url, init); },
    });
    assert.equal(report.code, "newer_version");
    assert.equal(report.message, NEWER_VERSION);
    assert.deepEqual(seen, [`${ep.url}/v1/info`]);
    assert.deepEqual(await remoteIds(ep), []);
    assert.equal((await page.store.load()).length, 1);
  });

  await withEndpoint({ rejectV1: true }, async (ep) => {
    const page = device(PATRICK);
    await arm(page, ep.url);
    await page.human.add_task("Local only");
    const seen = [];
    const report = await page.sync({
      fetchImpl: async (url, init) => { seen.push(String(url)); return fetch(url, init); },
    });
    assert.equal(report.code, "newer_version");
    assert.equal(report.message, NEWER_VERSION);
    assert.deepEqual(seen, [`${ep.url}/v1/info`]);
    assert.equal((await page.store.load()).length, 1);
  });
});

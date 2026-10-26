// Acceptance checks 1–4 against the in-memory reference endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { startSyncEndpoint } from "./sync-endpoint.mjs";

async function withEndpoint(options, fn) {
  const ep = await startSyncEndpoint(options);
  try { return await fn(ep); }
  finally { await ep.close(); }
}

const post = (ep, body) => fetch(`${ep.url}/v1/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const read = async (ep, since) => {
  const res = await fetch(`${ep.url}/v1/events?since=${since}`);
  return { status: res.status, body: await res.json() };
};

const line = (id, extra) => JSON.stringify({ id, ...extra });

test("1. read order: since=0 returns the posted lines in seq order, since=2 returns only seq 3", async () => {
  await withEndpoint({}, async (ep) => {
    const lines = [line("a", { type: "one", n: 1 }), line("b", { type: "two", keep: true }), line("c", { type: "three" })];
    const events = lines.map((l) => JSON.parse(l));
    const created = await post(ep, { expected_next_seq: 1, events });
    assert.equal(created.status, 200);
    const all = await read(ep, 0);
    assert.deepEqual(all.body.events.map((row) => row.seq), [1, 2, 3]);
    assert.deepEqual(all.body.events.map((row) => JSON.stringify(row.event)), lines);
    const tail = await read(ep, 2);
    assert.deepEqual(tail.body.events.map((row) => row.seq), [3]);
    assert.equal(JSON.stringify(tail.body.events[0].event), lines[2]);
  });
});

test("2. conditional append: expected_next_seq one too low is 409 and stores nothing", async () => {
  await withEndpoint({}, async (ep) => {
    assert.equal((await post(ep, { expected_next_seq: 1, events: [{ id: "a" }] })).status, 200);
    const conflict = await post(ep, { expected_next_seq: 1, events: [{ id: "b" }] });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "seq_conflict", next_seq: 2 });
    const after = await read(ep, 0);
    assert.equal(after.body.events.length, 1);
    assert.deepEqual(after.body.events.map((row) => row.event.id), ["a"]);
  });
});

test("3. idempotent by id: a second post skips every id at its original seq", async () => {
  await withEndpoint({}, async (ep) => {
    const events = [{ id: "a", type: "x" }, { id: "b", type: "y" }];
    assert.equal((await post(ep, { expected_next_seq: 1, events })).status, 200);
    const again = await post(ep, { expected_next_seq: 3, events });
    assert.equal(again.status, 200);
    const body = await again.json();
    assert.deepEqual(body.stored, []);
    assert.deepEqual(body.skipped, [
      { id: "a", code: "duplicate_id", seq: 1 },
      { id: "b", code: "duplicate_id", seq: 2 },
    ]);
    const got = await read(ep, 0);
    assert.deepEqual(got.body.events.map((row) => row.event.id), ["a", "b"]);
    assert.equal(new Set(got.body.events.map((row) => row.event.id)).size, 2);
  });
});

test("4. atomic batch: a second item with no id is 400 and stores nothing", async () => {
  await withEndpoint({}, async (ep) => {
    const res = await post(ep, { expected_next_seq: 1, events: [{ id: "a", type: "ok" }, { type: "missing" }] });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad_request" });
    const got = await read(ep, 0);
    assert.deepEqual(got.body.events, []);
    assert.equal(got.body.next_seq, 1);
  });
});

test("contract edges: bad since, empty tail, unknown version path", async () => {
  await withEndpoint({}, async (ep) => {
    assert.equal((await fetch(`${ep.url}/v1/events?since=-1`)).status, 400);
    assert.deepEqual(await (await fetch(`${ep.url}/v1/events?since=1.5`)).json(), { error: "bad_since" });
    const info = await (await fetch(`${ep.url}/v1/info`)).json();
    assert.equal(info.version, 1);
    assert.equal(info.contract, "tandem.sync");
    const empty = await read(ep, 0);
    assert.deepEqual(empty.body.events, []);
    assert.equal(empty.body.more, false);
    const missing = await fetch(`${ep.url}/v2/events`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "unknown_contract_version" });
    const bare = await fetch(`${ep.url}/v1/`);
    assert.equal(bare.status, 404);
    assert.deepEqual(await bare.json(), { error: "unknown_contract_version" });
  });
});

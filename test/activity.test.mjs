import test from "node:test";
import assert from "node:assert/strict";
import { ActivityProjection, relativePhrase } from "../src/activity.ts";
import { Session, bind } from "../src/registry.ts";
import { MemoryStore } from "../src/log.ts";

const T0 = Date.parse("2026-10-14T18:00:00.000Z");

test("relative phrases stay on the minute", () => {
  const at = "2026-10-14T18:00:00.000Z";
  assert.equal(relativePhrase(at, T0 + 30_000), "just now");
  assert.equal(relativePhrase(at, T0 + 2 * 60_000), "2m ago");
  assert.equal(relativePhrase(at, T0 + 3 * 60 * 60_000), "3h ago");
  assert.equal(relativePhrase(at, T0 + 2 * 24 * 60 * 60_000), "2d ago");
});

test("the activity projection folds forward and shows the newest four", async () => {
  const s = new Session(new MemoryStore(), () => T0);
  const human = bind(s, "human");
  const seen = [];
  for (const title of ["a", "b", "c", "d", "e"]) {
    await human.add_task(title);
    seen.push(s.activity.length);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  const window = s.activity.newest(4);
  assert.deepEqual(window.map((row) => row.text), [
    "You added “e”",
    "You added “d”",
    "You added “c”",
    "You added “b”",
  ]);
  assert.ok(window.every((row) => row.actor === "human" && !row.text.includes(":local")));
});

test("the log keeps the stamped actor and a reload is not a fresh change", async () => {
  const store = new MemoryStore();
  const s = await Session.open(store, () => T0);
  const human = bind(s, "human");
  const agent = bind(s, "agent");
  const mine = await human.add_task("Mine");
  const theirs = await agent.add_task("Theirs");
  assert.equal(s.activity.taskActor(mine.task_id), "human");
  assert.equal(s.activity.taskActor(theirs.task_id), "agent");
  assert.equal(s.activity.newest(1)[0].text, "Agent added “Theirs”");
  assert.deepEqual(s.exportEvents().events.map((e) => e.actor), ["human:local", "agent:local"]);
  const fresh = s.takeAppended();
  assert.deepEqual(fresh.map((e) => e.actor), ["human:local", "agent:local"]);
  assert.equal(s.takeAppended().length, 0);

  const reloaded = await Session.open(store, () => T0);
  assert.equal(reloaded.activity.length, 2);
  assert.equal(reloaded.activity.newest(1)[0].text, "Agent added “Theirs”");
  assert.equal(reloaded.takeAppended().length, 0);
  assert.deepEqual(reloaded.exportEvents().events.map((e) => e.actor), ["human:local", "agent:local"]);
});

test("focus starter follows the latest start event", async () => {
  const s = new Session(new MemoryStore(), () => T0);
  const agent = bind(s, "agent");
  const { task_id } = await agent.add_task("Focus me");
  await agent.start_pomodoro(task_id);
  assert.equal(s.activity.focusStarter(), "agent");
  assert.equal(s.activity.pomodoroCount(task_id), 1);
  assert.equal(s.activity.newest(1)[0].text, "Agent started focus on “Focus me”");
  assert.equal(s.activity.newest(1)[0].focus, true);
});

test("a projection built one event at a time matches a fold of the same events", () => {
  const step = new ActivityProjection();
  const batch = new ActivityProjection();
  const events = [
    { id: "1", time: "2026-10-14T18:00:00.000Z", actor: "human:local", type: "com.specdlc.tandem.task_added.v1", data: { task_id: "t", title: "T" } },
    { id: "2", time: "2026-10-14T18:01:00.000Z", actor: "agent:local", type: "com.specdlc.tandem.task_completed.v1", data: { task_id: "t" } },
  ];
  for (const e of events) step.apply(e);
  for (const e of events) batch.apply(e);
  assert.deepEqual(step.newest(4), batch.newest(4));
  assert.equal(step.taskActor("t"), "agent");
  assert.equal(step.newest(1)[0].text, "Agent completed “T”");
});

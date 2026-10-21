import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session, bind } from "../src/registry.ts";
import { MemoryStore } from "../src/log.ts";
import { foldBoard } from "../src/project.ts";
import { PAUSED_ROLL_OFF_MS } from "../src/timer.ts";
import {
  PAUSED_HIT_PX, PAUSED_STRENGTH_FADED, PAUSED_STRENGTH_FRESH,
  contrastRatio, cssRgb, paintPausedCard, pausedAgeLabel, pausedStrength, parseCssColor,
} from "../src/pausedFade.ts";

const light = {
  paper: parseCssColor("#fdfdfb"), yellow: parseCssColor("#f2c230"), ink: parseCssColor("#16181a"),
  onYellow: parseCssColor("#151515"), red: parseCssColor("#c8102e"), onRed: parseCssColor("#ffffff"), fill: true,
};
const darkFill = {
  paper: parseCssColor("#131517"), yellow: parseCssColor("#f2c230"), ink: parseCssColor("#e9eae6"),
  onYellow: parseCssColor("#151515"), red: parseCssColor("#ff5a4e"), onRed: parseCssColor("#131517"), fill: true,
};
const darkOutline = { ...darkFill, fill: false };

const assertFloors = (paint) => {
  assert.ok(contrastRatio(paint.title, paint.background) >= 4.5, `title ${contrastRatio(paint.title, paint.background)}`);
  assert.ok(contrastRatio(paint.time, paint.background) >= 4.5, `time ${contrastRatio(paint.time, paint.background)}`);
  assert.ok(contrastRatio(paint.resume, paint.background) >= 3, `resume ${contrastRatio(paint.resume, paint.background)}`);
  assert.ok(contrastRatio(paint.close, paint.background) >= 3, `close ${contrastRatio(paint.close, paint.background)}`);
  assert.equal(paint.hitPx, 44);
  assert.match(cssRgb(paint.title), /^rgb\(\d+ \d+ \d+\)$/);
  assert.match(cssRgb(paint.time), /^rgb\(\d+ \d+ \d+\)$/);
  assert.match(cssRgb(paint.resume), /^rgb\(\d+ \d+ \d+\)$/);
  assert.match(cssRgb(paint.close), /^rgb\(\d+ \d+ \d+\)$/);
};

test("paused strength is 0.75 at age 0, 0.25 at the window, and halfway between", () => {
  assert.equal(PAUSED_STRENGTH_FRESH, 0.75);
  assert.equal(PAUSED_STRENGTH_FADED, 0.25);
  assert.equal(pausedStrength(0, PAUSED_ROLL_OFF_MS), 0.75);
  assert.equal(pausedStrength(PAUSED_ROLL_OFF_MS / 2, PAUSED_ROLL_OFF_MS), 0.5);
  assert.equal(pausedStrength(PAUSED_ROLL_OFF_MS, PAUSED_ROLL_OFF_MS), 0.25);
  assert.equal(pausedStrength(PAUSED_ROLL_OFF_MS + 1, PAUSED_ROLL_OFF_MS), 0.25);
});

test("exactly two days reads paused 2d", () => {
  assert.equal(pausedAgeLabel(2 * 86_400_000), "paused 2d");
  assert.equal(pausedAgeLabel(2 * 86_400_000 - 1), "paused 1d");
  assert.equal(pausedAgeLabel(0), "paused 0d");
});

test("maximum fade keeps text at 4.5:1 and controls at 3:1", () => {
  for (const palette of [light, darkFill, darkOutline]) {
    for (const age of [0, PAUSED_ROLL_OFF_MS / 2, PAUSED_ROLL_OFF_MS, PAUSED_ROLL_OFF_MS + 86_400_000]) {
      const paint = paintPausedCard(age, PAUSED_ROLL_OFF_MS, palette);
      assertFloors(paint);
      assert.deepEqual(paint, paintPausedCard(age, PAUSED_ROLL_OFF_MS, palette));
    }
  }
  const faded = paintPausedCard(PAUSED_ROLL_OFF_MS, PAUSED_ROLL_OFF_MS, light);
  assert.equal(faded.strength, 0.25);
  assert.equal(faded.label, "paused 3d");
});

test("resume and close declare a 44px minimum and the same now paints the same card", async () => {
  assert.equal(PAUSED_HIT_PX, 44);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.paused-card__resume,\s*\n\.paused-card__close \{ min-width: 44px; min-height: 44px; \}/);
  assert.doesNotMatch(css, /\.paused-card__title[^{]*\{[^}]*opacity:/);
  assert.doesNotMatch(css, /\.paused-card__resume[^{]*\{[^}]*pointer-events:\s*none/);

  const T0 = Date.parse("2026-10-14T18:00:00.000Z");
  const clock = { t: T0 };
  const session = new Session(new MemoryStore(), () => clock.t);
  const human = bind(session, "human");
  const { task_id } = await human.add_task("Draft");
  await human.start_pomodoro(task_id);
  clock.t += 40_000;
  await human.pause_pomodoro();
  clock.t += 2 * 86_400_000;
  const now = clock.t;
  const board = foldBoard(session.exportEvents().events, now, PAUSED_ROLL_OFF_MS, false);
  assert.equal(board.paused[0].age_ms, 2 * 86_400_000);
  const paint = paintPausedCard(board.paused[0].age_ms, PAUSED_ROLL_OFF_MS, light);
  assert.equal(paint.label, "paused 2d");
  assert.deepEqual(paint, paintPausedCard(board.paused[0].age_ms, PAUSED_ROLL_OFF_MS, light));
  assert.deepEqual(foldBoard(session.exportEvents().events, now, PAUSED_ROLL_OFF_MS, false), board);
  assert.deepEqual(session.screenBoard(false).paused, board.paused);
  const before = session.exportEvents().events.length;
  session.screenBoard(true);
  assert.equal(session.exportEvents().events.length, before);
});

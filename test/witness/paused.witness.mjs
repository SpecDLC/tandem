import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { click, serve, launch, openSession, importTasks, exportLog, events } from "./support.mjs";
import { PAUSED_ROLL_OFF_MS } from "../../src/timer.ts";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const ONE = { schema: "tandem.tasks/v0", tasks: [{ id: "t1", title: "Draft the note" }] };
const DAY = 86_400_000;

function contrast(a, b) {
  const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const parse = (value) => [...value.matchAll(/[\d.]+/g)].slice(0, 3).map(Number);
  const l1 = L(parse(a));
  const l2 = L(parse(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function cardView(page, selector) {
  return page.locator(selector).evaluate((root) => {
    const cs = getComputedStyle(root);
    const title = root.querySelector("[data-field='task-title'], [data-field='title']");
    const time = root.querySelector("[data-field='clock'], [data-field='time']");
    const age = root.querySelector("[data-field='paused-age'], [data-field='age']");
    const resume = root.querySelector("[data-command='resume_pomodoro']");
    const close = root.querySelector("[data-command='stop_pomodoro']");
    const box = (el) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
    const style = (el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, border: s.borderTopColor, opacity: s.opacity, transform: s.transform, pointerEvents: s.pointerEvents, clip: s.clipPath };
    };
    return {
      strength: root.dataset.strength,
      background: cs.backgroundColor,
      label: age?.textContent ?? "",
      title: style(title),
      time: style(time),
      resume: { ...style(resume), box: box(resume) },
      close: { ...style(close), box: box(close) },
    };
  });
}

test("paused cards fade with age, keep contrast and a 44px hit area, and show stale writes nothing", async () => {
  const { context, page } = await openSession(browser, server.url);
  await importTasks(page, ONE);
  await click(page, "[data-command='start_pomodoro']");
  await page.clock.fastForward(1_000);
  await click(page, "[data-command='pause_pomodoro']");
  await page.waitForFunction(() => document.querySelector("[data-command='get_status']").dataset.phase === "paused");
  const pausedAt = await page.evaluate(() => Date.now());

  let view = await cardView(page, "[data-command='get_status']");
  assert.equal(view.strength, "0.75");
  assert.equal(view.label, "paused 0d");
  assert.ok(contrast(view.title.color, view.background) >= 4.5);
  assert.ok(contrast(view.time.color, view.background) >= 4.5);
  assert.ok(contrast(view.resume.border, view.background) >= 3);
  assert.ok(contrast(view.close.background, view.background) >= 3);
  assert.equal(view.title.opacity, "1");
  assert.equal(view.time.opacity, "1");
  assert.equal(view.resume.pointerEvents, "auto");
  assert.equal(view.close.pointerEvents, "auto");
  assert.equal(view.resume.transform, "none");
  assert.equal(view.close.transform, "none");
  assert.ok(view.resume.box.width >= 44 && view.resume.box.height >= 44);
  assert.ok(view.close.box.width >= 44 && view.close.box.height >= 44);

  const before = await exportLog(page);
  const refresh = async (time) => {
    await page.clock.setFixedTime(time);
    await click(page, "[data-action='show-stale']");
    await click(page, "[data-action='show-stale']");
  };
  await refresh(pausedAt + 2 * DAY);
  view = await cardView(page, "[data-command='get_status']");
  assert.equal(view.label, "paused 2d");
  assert.ok(Math.abs(Number(view.strength) - (0.75 - 0.5 * ((2 * DAY) / PAUSED_ROLL_OFF_MS))) < 1e-9);
  assert.equal(await exportLog(page), before);

  await refresh(pausedAt + PAUSED_ROLL_OFF_MS / 2);
  view = await cardView(page, "[data-command='get_status']");
  assert.equal(Number(view.strength), 0.5);

  await page.clock.setFixedTime(pausedAt + PAUSED_ROLL_OFF_MS);
  await click(page, "[data-action='show-stale']");
  await page.waitForFunction(() => document.querySelector("[data-field='paused-board']").children.length === 1);
  view = await cardView(page, "[data-field='paused-board'] .paused-card");
  assert.equal(view.strength, "0.25");
  assert.equal(view.label, "paused 3d");
  assert.ok(contrast(view.title.color, view.background) >= 4.5, `title ${contrast(view.title.color, view.background)}`);
  assert.ok(contrast(view.time.color, view.background) >= 4.5);
  assert.ok(contrast(view.resume.border, view.background) >= 3);
  assert.ok(contrast(view.close.background, view.background) >= 3);
  assert.equal(view.title.opacity, "1");
  assert.equal(view.resume.pointerEvents, "auto");
  assert.equal(view.close.pointerEvents, "auto");
  assert.equal(view.resume.clip, "none");
  assert.equal(view.close.clip, "none");
  assert.ok(view.resume.box.width >= 44 && view.resume.box.height >= 44);
  assert.ok(view.close.box.width >= 44 && view.close.box.height >= 44);
  assert.equal(await exportLog(page), before);
  assert.equal(events(before).some((e) => e.type.includes("stale")), false);

  await click(page, "[data-action='show-stale']");
  await page.waitForFunction(() => document.querySelector("[data-field='paused-board']").children.length === 0);
  assert.equal(await page.locator("[data-command='get_status']").getAttribute("data-phase"), "idle");
  assert.equal(await exportLog(page), before);
  await context.close();
});

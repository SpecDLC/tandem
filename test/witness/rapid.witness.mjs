// titles committed back to back are all kept, in order, and each row is on screen when the page reports idle.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, launch, openSession, screen } from "./support.mjs";

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser.close(); server.close(); });

const TITLES = ["one", "two", "three", "four", "five"];
const idle = (page) => page.waitForFunction(() => !document.body.hasAttribute("aria-busy"));

/** In the page: count submits, and each time aria-busy clears record how many submits and rows there were. */
const watchBusy = (page) => page.evaluate(() => {
  window.__submits = 0; window.__idles = [];
  document.querySelector("#add-form").addEventListener("submit", () => { window.__submits++; }, true);
  new MutationObserver(() => {
    if (!document.body.hasAttribute("aria-busy")) {
      window.__idles.push({ submits: window.__submits, rows: document.querySelectorAll("[data-command='list_tasks'] > li").length });
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["aria-busy"] });
});

async function check(page) {
  await idle(page);
  const s = await screen(page);
  assert.equal(s.rejection, "");
  assert.deepEqual(s.tasks.map((t) => t.text.replace(/ Start$/, "")), TITLES);
  assert.equal(await page.inputValue("#add-title"), "");
  const idles = await page.evaluate(() => window.__idles);
  assert.ok(idles.length > 0);
  for (const i of idles) assert.equal(i.rows, i.submits, `idle with ${i.rows} rows after ${i.submits} adds`);
  assert.equal(idles.at(-1).rows, TITLES.length);
}

test("rapid adds by clicking Add keep every title in order", async () => {
  const { context, page } = await openSession(browser, server.url);
  await watchBusy(page);
  // Type and press Add without waiting for the previous add. The page clock is paused, so yield with a MessageChannel, not setTimeout.
  await page.evaluate(async (titles) => {
    const box = document.querySelector("#add-title"), add = document.querySelector("[data-command='add_task']");
    for (const t of titles) {
      box.value = t; add.click();
      await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
    }
  }, TITLES);
  await check(page);
  await context.close();
});

test("rapid adds by pressing Enter keep every title in order", async () => {
  const { context, page } = await openSession(browser, server.url);
  await watchBusy(page);
  await page.focus("#add-title");
  for (const t of TITLES) { await page.fill("#add-title", t); await page.press("#add-title", "Enter"); }
  await check(page);
  await context.close();
});

test("an empty add still shows missing_title and adds nothing", async () => {
  const { context, page } = await openSession(browser, server.url);
  await page.press("#add-title", "Enter");
  await idle(page);
  const s = await screen(page);
  assert.equal(s.rejection, "missing_title");
  assert.equal(s.tasks.length, 0);
  await context.close();
});

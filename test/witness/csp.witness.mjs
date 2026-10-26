// Acceptance check 12. The browser blocks connect-src outside self and the saved endpoint.
// The JSONL coach witness stays in sync.witness.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, launch, openSession, click } from "./support.mjs";
import { startSyncEndpoint } from "../sync-endpoint.mjs";

let server, browser, endpoint;
before(async () => {
  server = await serve();
  browser = await launch();
  endpoint = await startSyncEndpoint();
});
after(async () => {
  await browser.close();
  server.close();
  await endpoint.close();
});

test("12. a fetch to any other origin is blocked by the page CSP", async () => {
  const origin = new URL(endpoint.url).origin;
  const { context, page } = await openSession(browser, server.url);
  await page.fill("#sync-endpoint", endpoint.url);
  await click(page, "[data-action='save-sync']");
  await page.reload();
  await page.waitForSelector("#status[data-ready='true']", { state: "attached" });

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert.equal(csp, `connect-src 'self' ${origin}`);
  assert.equal(await page.locator("[data-field='sync-origin']").getAttribute("data-origin"), origin);

  const failures = [];
  const consoleHits = [];
  page.on("requestfailed", (req) => failures.push({ url: req.url(), error: req.failure()?.errorText ?? "" }));
  page.on("console", (msg) => consoleHits.push(msg.text()));
  await page.evaluate(async () => { try { await fetch("https://example.com/"); } catch { /* expected */ } });
  const blocked = failures.some((row) => row.url.startsWith("https://example.com/") && row.error.includes("CSP"))
    || consoleHits.some((line) => line.includes("example.com") && line.includes("Content Security Policy"));
  assert.equal(blocked, true);

  const status = await page.evaluate(async (url) => {
    const res = await fetch(`${url}/v1/info`);
    return res.status;
  }, endpoint.url);
  assert.equal(status, 200);
  await context.close();
});

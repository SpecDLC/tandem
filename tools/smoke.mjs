// Smoke check against the production build served statically: the page loads and
// document.modelContext.registerTool exists. Serves dist/ itself; run `npm run build` first.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../dist/", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const f = join(root, normalize(p === "/" ? "/index.html" : p));
  if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(b); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
let failed = "";
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  try { await page.waitForSelector("#status[data-ready='true']", { timeout: 10000, state: 'attached' }); } catch { console.error("status:", await page.textContent("#status"), errors); throw new Error("page never became ready"); }
  const hasRegister = await page.evaluate(() => typeof document.modelContext?.registerTool === "function");
  if (!hasRegister) failed = "document.modelContext.registerTool is not a function";
  else if (errors.length) failed = `page errors: ${errors.join("; ")}`;
  else console.log(`smoke ok: ${url} loads and document.modelContext.registerTool exists`);
} finally { await browser.close(); server.close(); }
if (failed) { console.error("smoke FAILED: " + failed); process.exit(1); }

// Interface-level witness support. Serves the production build (dist/) and drives it through the page.
// Nothing here imports an application module: it reads the screen, the exported JSONL, and [data-rejection].
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../../dist/", import.meta.url).pathname;
const types = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json", ".png": "image/png",
};
export const T0 = Date.parse("2026-10-14T12:00:00.000Z");

export async function serve() {
  const server = createServer(async (req, res) => {
    const f = join(root, normalize(new URL(req.url, "http://x").pathname === "/" ? "/index.html" : new URL(req.url, "http://x").pathname));
    if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
    try { res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(await readFile(f)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

export async function launch() {
  return chromium.launch({ args: ["--no-sandbox"] });
}

/** A fresh browser context is a fresh working copy. The clock is paused at T0 + 1s. */
export async function openSession(browser, url) {
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true });
  const page = await context.newPage();
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0 + 1000);
  await page.goto(url);
  await page.waitForSelector("#status[data-ready='true']", { state: "attached" });
  return { context, page };
}

/** Open a collapsed ancestor so a control inside Advanced can be filled or clicked. */
async function reveal(page, selector) {
  await page.locator(selector).first().evaluate((el) => {
    let n = el.parentElement;
    while (n) {
      if (n.tagName === "DETAILS") n.open = true;
      n = n.parentElement;
    }
  });
}

/** Click a control and wait until the page reports its command finished (body is no longer aria-busy). */
export async function click(page, selector) {
  await reveal(page, selector);
  await page.click(selector);
  await page.waitForFunction(() => !document.body.hasAttribute("aria-busy"));
}

export const importTasks = async (page, payload) => {
  await reveal(page, "#tasks-input");
  await page.fill("#tasks-input", typeof payload === "string" ? payload : JSON.stringify(payload));
  await click(page, "[data-command='import_tasks']");
};

/** Click Export log and return the downloaded JSONL text. */
export async function exportLog(page) {
  const [dl] = await Promise.all([page.waitForEvent("download"), click(page, "[data-command='export_events']")]);
  return readFile(await dl.path(), "utf8");
}
export const events = (jsonl) => {
  const rows = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (rows.length && rows[0] && typeof rows[0] === "object" && rows[0].format && rows[0].specversion === undefined) rows.shift();
  return rows;
};

/** Default actor for an in-page tool call. A test can override `input.actor`. */
export const AGENT = { kind: "agent", name: "Agent" };

/**
 * Reads the stable hooks, not the visible sentences.
 * status.text is rebuilt as "Focus · {title} · {clock}" from [data-field] so the title claim stays checkable.
 * tasks.text is title, then [data-field=estimate], then [data-field=notes].
 * Rows from the open list and the done list stay in data-seq order.
 * rejection and result are rebuilt from data-code, data-path, and the result data-* counts.
 */
export async function screen(page) {
  return page.evaluate(() => {
    const card = document.querySelector("[data-command='get_status']");
    const title = card.querySelector("[data-field='task-title']")?.textContent?.trim() ?? "";
    const clock = card.querySelector("[data-field='clock']")?.textContent?.trim() ?? "";
    const phase = card.dataset.phase;
    const phaseLabel = phase === "break" ? "Break" : phase === "paused" ? "Paused" : "Focus";
    const text = phase === "idle" || title === "" ? "Idle" : `${phaseLabel} · ${title} · ${clock}`;
    const taskText = (li) => [li.querySelector("[data-field='title']"), li.querySelector("[data-field='estimate']"), li.querySelector("[data-field='notes']")]
      .map((n) => n?.textContent?.trim() ?? "").filter(Boolean).join(" ");
    const tasks = [...document.querySelectorAll("li[data-task-id]")]
      .sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq))
      .map((li) => ({ id: li.dataset.taskId, status: li.dataset.status, text: taskText(li) }));
    const box = document.querySelector("[data-rejection]");
    const rows = [...box.querySelectorAll("[data-code][data-path]")];
    const rejection = rows.length ? rows.map((r) => `${r.dataset.code} at ${r.dataset.path}`).join("\n") : (box.dataset.code || "");
    const out = document.querySelector("[data-result]");
    let result = "";
    if (out.dataset.kind === "import-tasks") {
      result = [`accepted ${out.dataset.accepted}, rejected ${out.dataset.rejected}, skipped ${out.dataset.skipped}`,
        ...[...out.querySelectorAll("[data-skip-id]")].map((s) => `skipped ${s.dataset.skipId}: ${s.dataset.code}`),
        ...[...out.querySelectorAll("[data-ignored-path]")].map((f) => `ignored field ${f.dataset.ignoredPath}`)].join("");
    } else if (out.dataset.kind === "import-events") {
      const note = out.dataset.note ? ` ${out.dataset.note}` : "";
      result = `imported ${out.dataset.imported}, rejected ${out.dataset.rejected}, skipped ${out.dataset.skipped}${note}`;
    } else if (out.dataset.kind === "export") {
      result = `exported ${out.dataset.count} events`;
    } else result = out.textContent;
    return {
      status: { phase, remaining: Number(card.dataset.remaining), text, taskTitle: phase === "idle" ? null : (title || null) },
      tasks, rejection, result,
    };
  });
}

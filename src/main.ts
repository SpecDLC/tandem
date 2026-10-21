import "../vendor/webmcp-polyfill/src/auto.ts";
import { actorWord, displayNow, relativePhrase, type ActivityItem } from "./activity.ts";
import { COMMAND_NAMES, Session, bind, type CommandName } from "./registry.ts";
import { commitTitle } from "./addControl.ts";
import { registerTools } from "./tools.ts";
import { IdbStore, toJsonl, type SessionEvent } from "./log.ts";
import { friendly, friendlyRow, showRejection } from "./messages.ts";
import { cssRgb, paintPausedCard, parseCssColor, type PausedPaint, type PausedPalette, type Rgb } from "./pausedFade.ts";
import type { PausedCard, Status, TaskView } from "./project.ts";
import { FOCUS_SECONDS, BREAK_SECONDS, PAUSED_ROLL_OFF_MS } from "./timer.ts";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const el = (tag: string, props: Record<string, unknown> = {}, data: Record<string, string> = {}): HTMLElement => {
  const e = Object.assign(document.createElement(tag), props);
  Object.assign(e.dataset, data);
  return e;
};

const status = $("#status");
const rejection = $("[data-rejection]");
const result = $("[data-result]");
const header = $("[data-command='get_status']");
const list = $("[data-command='list_tasks']");
const doneList = $("[data-field='done-list']");
const phone = window.matchMedia("(max-width: 600px)");

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const PAPER: Rgb = { r: 0xfd, g: 0xfd, b: 0xfb };
const INK: Rgb = { r: 0x16, g: 0x18, b: 0x1a };
const ON_YELLOW: Rgb = { r: 0x15, g: 0x15, b: 0x15 };
const RED: Rgb = { r: 0xc8, g: 0x10, b: 0x2e };
const ON_RED: Rgb = { r: 255, g: 255, b: 255 };

function surfaceIsFill(): boolean {
  const root = document.documentElement;
  if (root.dataset.spot === "fill") return true;
  if (root.dataset.spot === "outline") return false;
  if (root.dataset.look) return true;
  if (root.dataset.theme === "light") return true;
  if (root.dataset.theme === "dark") return false;
  return !window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readPalette(): PausedPalette {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: Rgb) => parseCssColor(cs.getPropertyValue(name)) ?? fallback;
  const yellow = parseCssColor(cs.getPropertyValue("--yellow"));
  return {
    paper: pick("--paper", PAPER),
    yellow: yellow ?? pick("--paper", PAPER),
    ink: pick("--ink", INK),
    onYellow: pick("--on-yellow", ON_YELLOW),
    red: pick("--red", RED),
    onRed: pick("--on-red", ON_RED),
    fill: surfaceIsFill() && yellow !== null,
  };
}

function paintPart(node: HTMLElement | null, paint: PausedPaint, kind: "title" | "time" | "resume" | "close" | "icon" | "accent", hit: boolean) {
  if (!node) return;
  if (kind === "title" || kind === "time") node.style.color = cssRgb(paint.title);
  if (kind === "icon") {
    node.style.color = cssRgb(paint.icon);
    node.style.borderColor = cssRgb(paint.icon);
    node.style.setProperty("--paused-icon", cssRgb(paint.icon));
  }
  if (kind === "accent") {
    node.style.backgroundColor = cssRgb(paint.accent);
    node.style.setProperty("--paused-accent", cssRgb(paint.accent));
  }
  if (kind === "resume") {
    node.style.color = cssRgb(paint.resume);
    node.style.borderColor = cssRgb(paint.resume);
    node.style.backgroundColor = cssRgb(paint.background);
    if (hit) { node.style.minWidth = `${paint.hitPx}px`; node.style.minHeight = `${paint.hitPx}px`; }
  }
  if (kind === "close") {
    node.style.color = cssRgb(paint.closeText);
    node.style.backgroundColor = cssRgb(paint.close);
    node.style.borderColor = cssRgb(paint.close);
    if (hit) { node.style.minWidth = `${paint.hitPx}px`; node.style.minHeight = `${paint.hitPx}px`; }
  }
}

function applyCardPaint(root: HTMLElement, paint: PausedPaint, parts: {
  title: HTMLElement | null; time: HTMLElement | null; age: HTMLElement | null;
  resume: HTMLElement | null; close: HTMLElement | null; icon: HTMLElement | null; accent: HTMLElement | null;
}, hit: boolean) {
  root.dataset.pausedFade = "true";
  root.dataset.strength = String(paint.strength);
  root.style.backgroundColor = cssRgb(paint.background);
  root.style.borderColor = cssRgb(paint.border);
  paintPart(parts.title, paint, "title", hit);
  paintPart(parts.time, paint, "time", hit);
  if (parts.age) { parts.age.textContent = paint.label; parts.age.style.color = cssRgb(paint.title); }
  paintPart(parts.resume, paint, "resume", hit);
  paintPart(parts.close, paint, "close", hit);
  paintPart(parts.icon, paint, "icon", hit);
  paintPart(parts.accent, paint, "accent", hit);
}

function clearPainted(node: HTMLElement) {
  node.style.color = "";
  node.style.backgroundColor = "";
  node.style.borderColor = "";
  node.style.minWidth = "";
  node.style.minHeight = "";
  node.style.removeProperty("--paused-icon");
  node.style.removeProperty("--paused-accent");
}
const field = (root: ParentNode, name: string) => root.querySelector<HTMLElement>(`[data-field='${name}']`);
const setField = (root: ParentNode, name: string, text: string) => {
  const n = field(root, name);
  if (n) n.textContent = text;
};

const READY = "Agent tools ready · WebMCP";
const activityList = $("[data-field='activity']");
const ticker = document.querySelector<HTMLDetailsElement>(".ticker");
const tickerRest = $("[data-field='ticker-rest']");
const presence = document.querySelector<HTMLElement>(".presence");

async function start(): Promise<void> {
  if (!document.modelContext) {
    status.textContent = "WebMCP is unavailable in this browser context.";
    return;
  }
  const session = await Session.open(new IdbStore(), () => Date.now());
  const cmd = bind(session, "human");
  const activity = session.activity;

  const announce = (text: string) => setField(header, "announce", text);
  let seenPhase: Status["phase"] | null = null;
  let toldMinute = false;

  const renderStatus = (s: Status) => {
    header.dataset.phase = s.phase;
    header.dataset.remaining = String(s.remaining_seconds);
    if (seenPhase === "focus" && s.phase === "break") announce("Focus finished. Break started.");
    if (s.phase === "focus" && s.remaining_seconds <= 60 && s.remaining_seconds > 0 && !toldMinute) {
      announce("One minute left.");
      toldMinute = true;
    }
    if (s.phase !== "focus") toldMinute = false;
    seenPhase = s.phase;

    const phaseName = s.phase === "focus" ? "Focus" : s.phase === "paused" ? "Paused" : "Break";
    const total = s.phase === "break" ? BREAK_SECONDS : FOCUS_SECONDS;
    const stopBtn = header.querySelector<HTMLButtonElement>("[data-command='stop_pomodoro']");
    if (stopBtn) stopBtn.textContent = s.phase === "paused" ? "Close" : "Stop";
    const resumeBtn = header.querySelector<HTMLButtonElement>("[data-command='resume_pomodoro']");
    if (resumeBtn) resumeBtn.dataset.pomodoroId = s.phase === "paused" ? (s.pomodoro_id ?? "") : "";
    if (s.phase === "idle") {
      setField(header, "task-title", "");
      setField(header, "clock", "");
      setField(header, "phase", "");
      setField(header, "elapsed", "");
      const ends = field(header, "ends-at");
      if (ends) { ends.textContent = ""; ends.removeAttribute("datetime"); }
    } else {
      const elapsed = Math.max(0, total - s.remaining_seconds);
      setField(header, "task-title", s.task_title ?? "");
      setField(header, "clock", mmss(s.remaining_seconds));
      setField(header, "phase", phaseName);
      setField(header, "phase-label", s.phase === "focus" ? "Now focusing" : s.phase === "paused" ? "Paused" : "On a break");
      setField(header, "elapsed", `${Math.floor(elapsed / 60)} of ${total / 60} min`);
      const ends = field(header, "ends-at");
      if (ends && s.phase === "paused") { ends.textContent = ""; ends.removeAttribute("datetime"); }
      else if (ends) {
        const end = new Date(Date.now() + s.remaining_seconds * 1000);
        ends.setAttribute("datetime", end.toISOString()); ends.textContent = `${end.toISOString().slice(11, 16)} UTC`;
      }
      const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
      field(header, "progress")?.style.setProperty("--progress", `${pct}%`);
      const who = activity.focusStarter();
      const actor = field(header, "actor");
      if (actor) { actor.dataset.actor = who; actor.textContent = actorWord(who); }
    }
    const tb = document.querySelector<HTMLElement>("[data-field='tb-phase']");
    if (tb) tb.textContent = s.phase === "idle" ? "Idle" : phaseName;
  };

  const tpl = $<HTMLTemplateElement>("#task-row");
  const renderRow = (t: TaskView, seq: number, runningId: string | null) => {
    const li = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    li.dataset.taskId = t.task_id;
    li.dataset.status = t.status;
    li.dataset.seq = String(seq);
    li.dataset.active = runningId === t.task_id ? "true" : "false";
    setField(li, "title", t.title);
    li.querySelector<HTMLElement>(".task__open")?.setAttribute("aria-label", `${t.title}. Show actions`);
    li.querySelector<HTMLElement>(".task__more")?.setAttribute("aria-label", `More actions for ${t.title}`);
    for (const c of li.querySelectorAll<HTMLElement>("[data-task-id]")) c.dataset.taskId = t.task_id;
    const box = li.querySelector<HTMLInputElement>("input[data-command='complete_task']");
    if (box) {
      box.checked = t.status === "completed";
      box.disabled = t.status === "completed";
      box.setAttribute("aria-label", `Complete ${t.title}`);
    }
    const switching = runningId !== null && runningId !== t.task_id && t.status === "open";
    const start = li.querySelector<HTMLButtonElement>(".task__start");
    if (start) {
      start.textContent = switching ? "Switch" : "Start";
      if (t.status !== "open") start.remove();
    }
    setField(li, "under-start", switching ? "Switch" : "Start");
    const openBtn = li.querySelector<HTMLElement>(".task__open");
    if (openBtn) openBtn.tabIndex = phone.matches ? 0 : -1;
    const meta = field(li, "meta");
    if (meta) {
      const actor = activity.taskActor(t.task_id);
      const n = activity.pomodoroCount(t.task_id);
      const chip = el("span", { className: "actor", textContent: actorWord(actor) });
      chip.dataset.actor = actor;
      const bits: Node[] = [document.createTextNode(`T-${String(seq + 1).padStart(2, "0")} · `), chip];
      if (n > 0) bits.push(document.createTextNode(` · ${n} pomodoro${n === 1 ? "" : "s"}`));
      meta.replaceChildren(...bits);
      if (t.estimate_pomodoros !== undefined) {
        meta.append(" ", el("span", { textContent: `${t.estimate_pomodoros} pomodoro${t.estimate_pomodoros === 1 ? "" : "s"}` }, { field: "estimate" }));
      }
      if (t.notes !== undefined) meta.append(" ", el("span", { textContent: t.notes }, { field: "notes" }));
    }
    return li;
  };

  const timePhrase = (iso: string) => `· ${relativePhrase(iso, displayNow(Date.now()))}`;
  const activityRow = (item: ActivityItem): HTMLElement => {
    const li = document.createElement("li");
    const who = el("span", { className: "who", textContent: actorWord(item.actor) });
    who.dataset.actor = item.actor;
    const body = document.createElement("span");
    body.append(document.createTextNode(`${item.text} `));
    const time = document.createElement("time");
    time.dateTime = item.time;
    time.textContent = timePhrase(item.time);
    body.append(time);
    li.append(who, body);
    return li;
  };
  const renderActivity = () => {
    const newest = activity.newest(4);
    activityList.replaceChildren(...newest.map(activityRow));
    const top = newest[0];
    if (ticker) ticker.hidden = !top;
    const who = field(document, "ticker-who");
    const text = field(document, "ticker-text");
    if (!top || !who || !text) {
      tickerRest.replaceChildren();
      return;
    }
    who.dataset.actor = top.actor;
    who.textContent = actorWord(top.actor);
    const time = document.createElement("time");
    time.dateTime = top.time;
    time.textContent = timePhrase(top.time);
    text.replaceChildren(document.createTextNode(`${top.text} `), time);
    tickerRest.replaceChildren(...newest.slice(1).map(activityRow));
  };

  const renderList = (s: Status) => {
    const listed = cmd.list_tasks();
    if (!listed.ok) return;
    const runningId = s.phase === "focus" ? s.task_id : null;
    list.replaceChildren();
    doneList.replaceChildren();
    let open = 0;
    let done = 0;
    listed.tasks.forEach((t, i) => {
      const row = renderRow(t, i, runningId);
      if (t.status === "completed") { done++; doneList.append(row); }
      else { open++; list.append(row); }
    });
    setField(document, "open-count", `${open} open`);
    setField(document, "done-count", String(done));
    const doneHead = document.querySelector<HTMLElement>("[data-field='done-head']");
    if (doneHead) doneHead.hidden = done === 0;
    const tbDone = document.querySelector<HTMLElement>("[data-field='tb-done']");
    if (tbDone) tbDone.textContent = String(done);
    const next = listed.tasks.find((t) => t.status === "open");
    const nextBtn = $<HTMLButtonElement>("[data-action='start-next']");
    nextBtn.dataset.taskId = next?.task_id ?? "";
    nextBtn.hidden = !next;
    setField(header, "next-title", next?.title ?? "");
  };

  const pausedTpl = $<HTMLTemplateElement>("#paused-card");
  const pausedBoard = $("[data-field='paused-board']");
  let showStale = false;

  const clearFocusFade = () => {
    const age = field(header, "paused-age");
    if (age) age.textContent = "";
    delete header.dataset.pausedFade;
    delete header.dataset.strength;
    header.style.backgroundColor = "";
    header.style.borderColor = "";
    const nodes = [field(header, "task-title"), field(header, "clock"), age, field(header, "phase"), field(header, "progress"),
      header.querySelector<HTMLElement>("[data-command='resume_pomodoro']"),
      header.querySelector<HTMLElement>("[data-command='stop_pomodoro']")];
    for (const node of nodes) if (node) clearPainted(node);
  };

  const pausedRow = (card: PausedCard, palette: PausedPalette): HTMLElement => {
    const li = pausedTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    const paint = paintPausedCard(card.age_ms, PAUSED_ROLL_OFF_MS, palette);
    li.dataset.pomodoroId = card.pomodoro_id;
    li.dataset.ageMs = String(card.age_ms);
    setField(li, "title", card.task_title ?? "");
    setField(li, "time", mmss(card.remaining_seconds));
    const resume = li.querySelector<HTMLButtonElement>("[data-command='resume_pomodoro']");
    const close = li.querySelector<HTMLButtonElement>("[data-command='stop_pomodoro']");
    const title = card.task_title ?? "paused timer";
    if (resume) { resume.dataset.pomodoroId = card.pomodoro_id; resume.setAttribute("aria-label", `Resume ${title}`); }
    if (close) { close.dataset.pomodoroId = card.pomodoro_id; close.setAttribute("aria-label", `Close ${title}`); }
    applyCardPaint(li, paint, {
      title: field(li, "title"), time: field(li, "time"), age: field(li, "age"),
      resume, close,
      icon: li.querySelector<HTMLElement>(".paused-card__icon"),
      accent: li.querySelector<HTMLElement>(".paused-card__accent"),
    }, true);
    return li;
  };

  const renderPaused = (s: Status) => {
    const palette = readPalette();
    const current = s.phase === "paused" ? s.paused.find((c) => c.pomodoro_id === s.pomodoro_id) : undefined;
    if (current) {
      applyCardPaint(header, paintPausedCard(current.age_ms, PAUSED_ROLL_OFF_MS, palette), {
        title: field(header, "task-title"), time: field(header, "clock"), age: field(header, "paused-age"),
        resume: header.querySelector<HTMLElement>("[data-command='resume_pomodoro']"),
        close: header.querySelector<HTMLElement>("[data-command='stop_pomodoro']"),
        icon: field(header, "phase"), accent: field(header, "progress"),
      }, false);
    } else clearFocusFade();
    const extras = s.paused.filter((c) => c.pomodoro_id !== current?.pomodoro_id);
    pausedBoard.dataset.includeStale = showStale ? "true" : "false";
    pausedBoard.replaceChildren(...extras.map((c) => pausedRow(c, palette)));
  };

  // Paint from the running projection. A page read must not call export_events.
  // Show stale is a view of the same fold; it does not append.
  const render = () => {
    session.takeAppended();
    const s = session.screenBoard(showStale);
    renderList(s);
    renderStatus(s);
    renderPaused(s);
    renderActivity();
    paintTouches();
  };

  const showStaleBox = document.querySelector<HTMLInputElement>("[data-action='show-stale']");
  showStaleBox?.addEventListener("change", () => {
    showStale = showStaleBox.checked;
    render();
  });

  interface Touch { until: number; tool: string; taskId: string | null }
  const touches: Touch[] = [];
  function paintTouches() {
    const now = Date.now();
    const live = touches.filter((t) => t.until > now);
    touches.length = 0;
    touches.push(...live);
    for (const node of document.querySelectorAll<HTMLElement>("[data-touched='agent']")) {
      node.dataset.touched = "";
      delete node.dataset.touchedTool;
    }
    for (const t of touches) {
      const node = t.taskId
        ? document.querySelector<HTMLElement>(`li[data-task-id="${CSS.escape(t.taskId)}"] .task__front`)
        : document.querySelector<HTMLElement>(".focus");
      if (!node) continue;
      node.dataset.touched = "agent";
      node.dataset.touchedTool = t.tool;
    }
  }
  /** null marks the focus card. undefined marks nothing. A task id marks that row. */
  function markTarget(e: SessionEvent): string | null | undefined {
    if (!e.actor.startsWith("agent")) return undefined;
    if (e.type.endsWith("pomodoro_started.v1") || e.type.endsWith("pomodoro_stopped.v1")
      || e.type.endsWith("pomodoro_paused.v1") || e.type.endsWith("pomodoro_resumed.v1")) return null;
    if (e.type.endsWith("task_added.v1") || e.type.endsWith("task_imported.v1") || e.type.endsWith("task_completed.v1")) {
      return typeof e.data.task_id === "string" ? e.data.task_id : undefined;
    }
    return undefined;
  }
  function addTouches(tool: string, batch: readonly SessionEvent[]) {
    const until = Date.now() + 4000;
    for (const e of batch) {
      const target = markTarget(e);
      if (target === undefined) continue;
      touches.push({ until, tool, taskId: target });
    }
    paintTouches();
    window.setTimeout(paintTouches, 4000);
  }
  let presenceTimer = 0;
  function showPresence(name: string) {
    if (!presence) return;
    presence.dataset.state = "active";
    const label = field(presence, "presence");
    if (!label) return;
    const code = document.createElement("code");
    code.textContent = name;
    label.replaceChildren(document.createTextNode("Agent · "), code);
    window.clearTimeout(presenceTimer);
    presenceTimer = window.setTimeout(() => {
      presence.dataset.state = "ready";
      label.textContent = READY;
    }, 3000);
  }
  const afterAgent = (name: CommandName, _result: unknown) => {
    const batch = session.takeAppended();
    render();
    addTouches(name, batch);
    showPresence(name);
  };

  const clearOut = () => {
    rejection.replaceChildren();
    delete rejection.dataset.code;
    result.replaceChildren();
    for (const k of ["kind", "accepted", "rejected", "skipped", "imported", "count"]) delete result.dataset[k];
  };
  const showRows = (rows: { code: string; path: string }[]) => {
    rejection.replaceChildren();
    delete rejection.dataset.code;
    if (rows.length === 0) return;
    for (const row of rows) {
      rejection.append(el("div", { textContent: friendlyRow(row.code, row.path) }, { code: row.code, path: row.path }));
    }
  };

  /** Every control runs one command, then shows its rejection code or clears it. */
  const run = async (fn: () => unknown) => {
    clearOut();
    const r = (await fn()) as { ok: boolean; code?: string };
    if (!r.ok) showRejection(rejection, r.code);
    render();
    return r;
  };
  /** The page is aria-busy from the control event until its command has finished and its output is on screen. */
  let pending = 0;
  const on = (target: HTMLElement, type: string, fn: (ev: Event) => unknown) =>
    target.addEventListener(type, (ev) => {
      pending++;
      document.body.setAttribute("aria-busy", "true");
      void Promise.resolve(fn(ev)).finally(() => { if (--pending === 0) document.body.removeAttribute("aria-busy"); });
    });

  const onStart = (id: string | undefined) => {
    if (!id) return;
    const s = cmd.get_status();
    const go = s.phase === "focus" && s.task_id && s.task_id !== id
      ? async () => {
          const stopped = await cmd.stop_pomodoro();
          if (!stopped.ok) return stopped;
          return cmd.start_pomodoro(id);
        }
      : () => cmd.start_pomodoro(id);
    return run(go).then((r) => {
      if (r.ok) {
        const title = cmd.get_status().task_title;
        announce(title ? `Focus started on ${title}.` : "Focus started.");
      }
      return r;
    });
  };

  on($("[data-command='import_tasks']"), "click", async () => {
    const text = $<HTMLTextAreaElement>("#tasks-input").value;
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { payload = undefined; }
    const r = await run(() => cmd.import_tasks(payload)) as Awaited<ReturnType<typeof cmd.import_tasks>>;
    if (!r.ok) return;
    result.dataset.kind = "import-tasks";
    result.dataset.accepted = String(r.accepted);
    result.dataset.rejected = String(r.rejected.length);
    result.dataset.skipped = String(r.skipped.length);
    result.append(el("div", { textContent: `Accepted ${r.accepted}. Rejected ${r.rejected.length}. Skipped ${r.skipped.length}.` }));
    for (const s of r.skipped) {
      result.append(el("div", { textContent: `${s.id}: ${friendly(s.code).title}` }, { skipId: s.id, code: s.code }));
    }
    for (const f of r.ignored_fields) result.append(el("div", { textContent: `Ignored ${f.path}` }, { ignoredPath: f.path }));
    showRows(r.rejected);
  });
  // Add click and Enter both submit this form: one path, one command.
  on($("#add-form"), "submit", (ev) => {
    ev.preventDefault();
    return run(() => commitTitle($<HTMLInputElement>("#add-title"), (t) => cmd.add_task(t)));
  });
  on($("[data-command='stop_pomodoro']"), "click", () => run(() => cmd.stop_pomodoro()).then((r) => {
    if (r.ok) announce("Timer stopped.");
    return r;
  }));
  on($("[data-command='pause_pomodoro']"), "click", () => run(() => cmd.pause_pomodoro()).then((r) => {
    if (r.ok) announce("Timer paused.");
    return r;
  }));
  on($("[data-command='resume_pomodoro']"), "click", (ev) => {
    const id = (ev.currentTarget as HTMLButtonElement).dataset.pomodoroId;
    return run(() => cmd.resume_pomodoro(id)).then((r) => {
      if (r.ok) announce("Focus resumed.");
      return r;
    });
  });
  on(pausedBoard, "click", (ev) => {
    const target = ev.target as HTMLElement;
    const resume = target.closest<HTMLButtonElement>("[data-command='resume_pomodoro']");
    if (resume && pausedBoard.contains(resume)) {
      return run(() => cmd.resume_pomodoro(resume.dataset.pomodoroId)).then((r) => {
        if (r.ok) announce("Focus resumed.");
        return r;
      });
    }
    const close = target.closest<HTMLButtonElement>("[data-command='stop_pomodoro']");
    if (close && pausedBoard.contains(close)) {
      return run(() => cmd.stop_pomodoro(close.dataset.pomodoroId)).then((r) => {
        if (r.ok) announce("Timer stopped.");
        return r;
      });
    }
  });
  on($("[data-action='start-next']"), "click", () => onStart($<HTMLButtonElement>("[data-action='start-next']").dataset.taskId));
  on($("[data-command='export_events']"), "click", async () => {
    const r = await run(() => cmd.export_events("")) as ReturnType<typeof cmd.export_events>;
    if (!r.ok) return;
    const url = URL.createObjectURL(new Blob([toJsonl(r.events)], { type: "application/x-ndjson" }));
    const a = el("a", { href: url, download: "events.jsonl" });
    document.body.append(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    result.dataset.kind = "export";
    result.dataset.count = String(r.events.length);
    result.append(el("div", { textContent: `Exported ${r.events.length} events.` }));
  });
  on($("[data-command='import_events']"), "click", async () => {
    const lines = $<HTMLTextAreaElement>("#events-input").value.split("\n").filter((l) => l.trim() !== "");
    const evs = lines.map((l) => { try { return JSON.parse(l) as unknown; } catch { return null; } });
    const r = await run(() => cmd.import_events(evs)) as Awaited<ReturnType<typeof cmd.import_events>>;
    if (!r.ok) return;
    result.dataset.kind = "import-events";
    result.dataset.imported = String(r.imported);
    result.dataset.rejected = String(r.rejected.length);
    result.dataset.skipped = String(r.skipped.length);
    result.append(el("div", { textContent: `Imported ${r.imported}. Rejected ${r.rejected.length}. Skipped ${r.skipped.length}.` }));
    for (const s of r.skipped) result.append(el("div", { textContent: `${s.id}: ${friendly(s.code).title}` }, { skipId: s.id, code: s.code }));
    showRows(r.rejected);
  });
  on($("#events-file"), "change", async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) $<HTMLTextAreaElement>("#events-input").value = await f.text();
  });

  const onRowClick = (ev: Event) => {
    const t = ev.target as HTMLElement;
    if (t.closest(".task__more")) return;
    if (t.closest(".menu")) {
      const done = t.closest<HTMLButtonElement>("button[data-command='complete_task']");
      if (!done) return;
      closeMenu({ focus: false });
      return run(() => cmd.complete_task(done.dataset.taskId));
    }
    const startBtn = t.closest<HTMLElement>("[data-command='start_pomodoro']");
    if (startBtn) return onStart(startBtn.dataset.taskId);
  };
  const onRowChange = (ev: Event) => {
    const b = ev.target as HTMLInputElement;
    if (b.dataset.command === "complete_task") return run(() => cmd.complete_task(b.dataset.taskId));
  };
  on(list, "click", onRowClick);
  on(doneList, "click", onRowClick);
  on(list, "change", onRowChange);
  on(doneList, "change", onRowChange);

  let openMenu: HTMLElement | null = null;
  const closeMenu = (opts: { focus: boolean }) => {
    if (!openMenu) return;
    const menu = openMenu;
    const more = menu.closest("li")?.querySelector<HTMLElement>(".task__more");
    menu.hidden = true;
    more?.setAttribute("aria-expanded", "false");
    openMenu = null;
    if (opts.focus) more?.focus();
  };
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const more = t.closest<HTMLElement>(".task__more");
    if (more) {
      const menu = more.closest("li")?.querySelector<HTMLElement>(".menu");
      if (!menu) return;
      const willOpen = menu.hidden;
      closeMenu({ focus: false });
      if (willOpen) {
        menu.hidden = false;
        more.setAttribute("aria-expanded", "true");
        openMenu = menu;
        menu.querySelector<HTMLElement>("[role='menuitem']")?.focus();
      }
      return;
    }
    if (openMenu && !t.closest(".menu")) closeMenu({ focus: false });
  });
  document.addEventListener("keydown", (ev) => {
    if (!openMenu) return;
    const items = [...openMenu.querySelectorAll<HTMLElement>("[role='menuitem']")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (ev.key === "Escape") { ev.preventDefault(); closeMenu({ focus: true }); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i <= 0 ? items.length - 1 : i - 1)]?.focus(); }
  });

  // The timer shell: when the clock reaches the scheduled end, record the one finish. Not a command.
  setInterval(() => { void session.finishPomodoro().then(render); }, 1000);
  // Relative times change once a minute. The projection itself is not rebuilt from the log.
  setInterval(renderActivity, 60_000);

  await registerTools(document.modelContext, bind(session, "agent"), afterAgent);
  render();
  status.textContent = `Shell ready. ${COMMAND_NAMES.length} commands declared.`;
  status.dataset.ready = "true";
}

void start();
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}

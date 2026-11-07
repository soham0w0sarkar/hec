import type { Screen } from "./scene";

type Claim = {
  text: string;
  date: string | null;
  person: string | null;
  source: string | null;
  quote: string | null;
  message_ids: number[];
};

type ChatTurn = { role: "user" | "assistant"; text: string; claims?: Claim[]; caveats?: string[] };

type TimelineEvent = {
  id: number;
  title: string;
  summary: string;
  category: string;
  occurredAtIst: string;
  quote: string | null;
  evidenceMessageIds: number[];
};

const CONVERSATION_KEY = "hec.conversation";

const thread: ChatTurn[] = [];
let conversationId = sessionStorage.getItem(CONVERSATION_KEY);
let shown: Screen = "world";
let panel: HTMLElement | null = null;
let goBack: () => void = () => {};

const perch = document.createElement("canvas");
perch.id = "perch";
perch.className = "perch";

export function mountPanels(root: HTMLElement, back: () => void): void {
  panel = document.createElement("section");
  panel.id = "panel";
  panel.className = "panel";
  panel.hidden = true;
  root.append(panel);
  goBack = back;
}

/** Shows the place that just opened. Stays put when the screen has not changed. */
export function syncPanel(screen: Screen): void {
  if (!panel || screen === shown) return;
  shown = screen;
  panel.hidden = screen === "world";
  panel.className = screen === "world" ? "panel" : `panel room ${screen}`;
  panel.replaceChildren();
  if (screen === "chat") renderChat();
  else if (screen === "timeline") renderTimeline();
  else if (screen === "stats") renderStats();
  if (screen !== "world") panel.append(perch);
}

/** 7-wide pixel masks, drawn as SVG rects so they stay crisp at any size. */
const ICONS = {
  close: ["1000001", "0100010", "0010100", "0001000", "0010100", "0100010", "1000001"],
  fresh: ["0001000", "0001000", "0001000", "1111111", "0001000", "0001000", "0001000"],
  send: ["0001000", "0001100", "1111110", "1111111", "1111110", "0001100", "0001000"],
  heart: ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"],
  lamp: ["0011100", "0111110", "0011100", "0001000", "0001000", "0001000", "0011100"],
  eye: ["0011100", "0111110", "1101011", "1110111", "1101011", "0111110", "0011100"],
  bars: ["1000100", "1000100", "1001100", "1001100", "1101100", "1101100", "1111111"],
} as const;

function pixelIcon(name: keyof typeof ICONS): SVGSVGElement {
  const rows = ICONS[name];
  const width = rows[0]?.length ?? 0;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${rows.length}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.classList.add("px", `px-${name}`);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== "1") continue;
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      svg.append(rect);
    }
  });
  return svg;
}

function iconButton(name: keyof typeof ICONS, label: string, type: "button" | "submit" = "button"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = type;
  button.className = "icon";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(pixelIcon(name));
  return button;
}

let waiting = false;

function renderChat(): void {
  const root = panel;
  if (!root) return;

  const bar = document.createElement("header");
  bar.className = "bar";
  const fresh = iconButton("fresh", "New chat");
  const close = iconButton("close", "Back");
  close.addEventListener("click", () => goBack());
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(fresh, close);
  bar.append(heading("Chat"), tools);

  const log = document.createElement("div");
  log.className = "sheet log";
  log.setAttribute("aria-live", "polite");

  const form = document.createElement("form");
  form.className = "ask";
  const input = document.createElement("input");
  input.name = "question";
  input.maxLength = 2000;
  input.required = true;
  input.autocomplete = "off";
  input.placeholder = "Who said it first?";
  input.setAttribute("aria-label", "Question");
  const send = iconButton("send", "Ask", "submit");
  send.classList.add("send");
  form.append(input, send);

  fresh.addEventListener("click", () => {
    thread.length = 0;
    conversationId = null;
    sessionStorage.removeItem(CONVERSATION_KEY);
    paintThread(log);
    input.focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || waiting) return;
    input.value = "";
    void ask(log, question, send);
  });

  root.append(bar, log, form);
  paintThread(log);
  input.focus();
}

async function ask(log: HTMLElement, question: string, send: HTMLButtonElement): Promise<void> {
  thread.push({ role: "user", text: question });
  waiting = true;
  paintThread(log);
  send.disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, conversationId }),
    });
    const body = (await response.json()) as {
      error?: string;
      conversationId?: string;
      text?: string;
      claims?: Claim[];
      caveats?: string[];
    };
    if (!response.ok || !body.text) {
      thread.push({ role: "assistant", text: body.error ?? "The answer could not be completed." });
    } else {
      if (body.conversationId) {
        conversationId = body.conversationId;
        sessionStorage.setItem(CONVERSATION_KEY, body.conversationId);
      }
      thread.push({ role: "assistant", text: body.text, claims: body.claims ?? [], caveats: body.caveats ?? [] });
    }
  } catch {
    thread.push({ role: "assistant", text: "The cottage could not reach the API." });
  } finally {
    waiting = false;
    send.disabled = false;
    paintThread(log);
  }
}

function paintThread(log: HTMLElement): void {
  log.replaceChildren();
  if (thread.length === 0 && !waiting) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.append(pixelIcon("heart"));
    log.append(empty);
    return;
  }
  for (const turn of thread) {
    const row = document.createElement("div");
    row.className = turn.role === "user" ? "row mine" : "row";
    const bubble = document.createElement("article");
    bubble.className = "bubble";
    const text = document.createElement("p");
    text.textContent = turn.text;
    bubble.append(text);
    for (const claim of turn.claims ?? []) bubble.append(proofCard(claim));
    if (turn.role === "assistant") row.append(avatar());
    row.append(bubble);
    log.append(row);
  }
  if (waiting) {
    const row = document.createElement("div");
    row.className = "row";
    const dots = document.createElement("div");
    dots.className = "bubble typing";
    dots.setAttribute("aria-label", "Thinking");
    dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    row.append(avatar(), dots);
    log.append(row);
  }
  log.scrollTop = log.scrollHeight;
}

function avatar(): HTMLElement {
  const node = document.createElement("span");
  node.className = "avatar";
  node.append(pixelIcon("heart"));
  return node;
}

function proofCard(claim: Claim): HTMLElement {
  const card = document.createElement("blockquote");
  card.className = "proof-card";
  const bits = [claim.date, claim.person, claim.source].filter(Boolean);
  if (bits.length > 0) {
    const meta = document.createElement("div");
    meta.className = "meta";
    for (const bit of bits) {
      const chip = document.createElement("span");
      chip.textContent = String(bit);
      meta.append(chip);
    }
    card.append(meta);
  }
  if (claim.quote) {
    const quote = document.createElement("p");
    quote.className = "quote";
    quote.textContent = `“${claim.quote}”`;
    card.append(quote);
  } else {
    const text = document.createElement("p");
    text.className = "quote";
    text.textContent = claim.text;
    card.append(text);
  }
  return card;
}

function roomBar(title: string): HTMLElement {
  const bar = document.createElement("header");
  bar.className = "bar";
  const close = iconButton("close", "Back");
  close.addEventListener("click", () => goBack());
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(close);
  bar.append(heading(title), tools);
  return bar;
}

function emptyMark(icon: keyof typeof ICONS): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.append(pixelIcon(icon));
  return empty;
}

function waitingDots(): HTMLElement {
  const dots = document.createElement("div");
  dots.className = "typing wait";
  for (let i = 0; i < 3; i++) dots.append(document.createElement("span"));
  return dots;
}

function renderTimeline(): void {
  const root = panel;
  if (!root) return;
  const list = document.createElement("div");
  list.className = "sheet path";
  list.append(waitingDots());
  root.append(roomBar("Timeline"), list);
  void loadTimeline(list);
}

async function loadTimeline(list: HTMLElement): Promise<void> {
  try {
    const response = await fetch("/api/timeline?limit=30");
    const body = (await response.json()) as { error?: string; events?: TimelineEvent[] };
    list.replaceChildren();
    if (!response.ok) {
      list.append(note(body.error ?? "The timeline could not be read."));
      return;
    }
    const events = body.events ?? [];
    if (events.length === 0) {
      list.append(emptyMark("lamp"));
      return;
    }
    for (const event of events) {
      const item = document.createElement("article");
      item.className = "mile";
      const post = document.createElement("span");
      post.className = "lamp";
      const bodyCard = document.createElement("div");
      bodyCard.className = "mile-body";
      const meta = document.createElement("div");
      meta.className = "meta";
      for (const bit of [event.occurredAtIst.slice(0, 10), event.category]) {
        const chip = document.createElement("span");
        chip.textContent = bit;
        meta.append(chip);
      }
      const title = document.createElement("p");
      title.className = "mile-title";
      title.textContent = event.title;
      bodyCard.append(meta, title);
      if (event.quote) {
        const quote = document.createElement("p");
        quote.className = "quote";
        quote.textContent = `“${event.quote}”`;
        bodyCard.append(quote);
      }
      const evidence = event.evidenceMessageIds[0];
      if (evidence) {
        const open = iconButton("eye", "Read");
        open.addEventListener("click", () => void loadContext(bodyCard, evidence, open));
        bodyCard.append(open);
      }
      item.append(post, bodyCard);
      list.append(item);
    }
  } catch {
    list.replaceChildren(note("The cottage could not reach the API."));
  }
}

async function loadContext(item: HTMLElement, messageId: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const response = await fetch(`/api/context?messageId=${messageId}`);
    const body = (await response.json()) as {
      error?: string;
      messages?: { id: number; name: string; sentAtIst: string; source: string; text: string }[];
    };
    const box = document.createElement("div");
    box.className = "context";
    if (!response.ok || !body.messages) {
      box.append(note(body.error ?? "Those messages could not be read."));
    } else {
      for (const message of body.messages) {
        const row = document.createElement("p");
        row.className = "line";
        const who = document.createElement("span");
        who.textContent = message.name;
        const when = document.createElement("time");
        when.textContent = message.sentAtIst.slice(11, 16);
        const said = document.createElement("span");
        said.textContent = message.text;
        row.append(who, when, said);
        box.append(row);
      }
    }
    item.append(box);
  } catch {
    item.append(note("The cottage could not reach the API."));
  }
}

function renderStats(): void {
  const root = panel;
  if (!root) return;
  const sheet = document.createElement("div");
  sheet.className = "sheet score";
  sheet.append(waitingDots());
  root.append(roomBar("Stats"), sheet);
  void loadStats(sheet);
}

async function loadStats(sheet: HTMLElement): Promise<void> {
  try {
    const response = await fetch("/api/stats");
    const body = (await response.json()) as {
      error?: string;
      streaks?: { longest: number; current: number; longestFrom: string | null; longestUntil: string | null };
      busiestDays?: { day: string; messages: number }[];
      whoMessagesFirst?: { name: string; days: number }[];
      calls?: number;
      messages?: number;
    };
    sheet.replaceChildren();
    if (!response.ok || !body.streaks) {
      sheet.append(note(body.error ?? "The counts could not be read."));
      return;
    }
    const lines = body.messages ?? 0;
    sheet.append(levelCard(lines));
    sheet.append(streakCard(body.streaks.longest, body.streaks.current, body.calls ?? 0));
    const first = body.whoMessagesFirst ?? [];
    if (first.length > 0) sheet.append(versus(first));
    const days = body.busiestDays ?? [];
    if (days.length > 0) sheet.append(hiScore(days));
  } catch {
    sheet.replaceChildren(note("The cottage could not reach the API."));
  }
}

function heading(text: string): HTMLElement {
  const node = document.createElement("h1");
  node.textContent = text;
  return node;
}

function note(text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = "note";
  node.textContent = text;
  return node;
}

const LEVEL_SPAN = 10_000;
const XP_CELLS = 16;

/** One level per 10,000 lines. The bar is the remainder toward the next level. */
function levelCard(lines: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "level";
  const lv = document.createElement("b");
  lv.textContent = `LV ${Math.floor(lines / LEVEL_SPAN) + 1}`;
  const bar = document.createElement("div");
  bar.className = "xp";
  const filled = Math.round(((lines % LEVEL_SPAN) / LEVEL_SPAN) * XP_CELLS);
  for (let i = 0; i < XP_CELLS; i++) {
    const cell = document.createElement("i");
    if (i < filled) cell.className = "on";
    bar.append(cell);
  }
  const cap = document.createElement("span");
  cap.textContent = `${lines} LINES`;
  card.append(lv, bar, cap);
  return card;
}

function rankName(days: number): string {
  if (days >= 365) return "YEAR";
  if (days >= 200) return "LEGEND";
  if (days >= 100) return "SEASON";
  if (days >= 30) return "MONTH";
  if (days >= 7) return "WEEK";
  return "SPARK";
}

function streakCard(longest: number, current: number, calls: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "streak";
  const heart = pixelIcon("heart");
  const num = document.createElement("b");
  num.textContent = String(current);
  const rank = document.createElement("span");
  rank.className = "rank";
  rank.textContent = rankName(current);
  card.append(heart, num, rank);
  if (current > 0 && current === longest) {
    const best = document.createElement("span");
    best.className = "best";
    best.textContent = "BEST";
    card.append(best);
  }
  const chip = document.createElement("span");
  chip.className = "calls";
  chip.textContent = `${calls} CALLS`;
  card.append(chip);
  return card;
}

function tone(name: string): string {
  return name.toLowerCase().includes("tanvi") ? "rose" : "blue";
}

/** Who wrote first, as two scores on one bar. */
function versus(rows: { name: string; days: number }[]): HTMLElement {
  const total = rows.reduce((sum, row) => sum + row.days, 0) || 1;
  const box = document.createElement("div");
  box.className = "versus";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = "FIRST";
  box.append(tag);
  for (const row of rows) {
    const side = document.createElement("div");
    side.className = `side ${tone(row.name)}`;
    const who = document.createElement("span");
    who.textContent = row.name;
    const track = document.createElement("i");
    const fill = document.createElement("b");
    fill.style.width = `${Math.round((row.days / total) * 100)}%`;
    track.append(fill);
    const count = document.createElement("em");
    count.textContent = String(row.days);
    side.append(who, track, count);
    box.append(side);
  }
  return box;
}

function hiScore(days: { day: string; messages: number }[]): HTMLElement {
  const box = document.createElement("ol");
  box.className = "hiscore";
  days.forEach((day, index) => {
    const row = document.createElement("li");
    const place = document.createElement("b");
    place.textContent = String(index + 1);
    const date = document.createElement("span");
    date.textContent = day.day.slice(5);
    const score = document.createElement("em");
    score.textContent = String(day.messages);
    row.append(place, date, score);
    box.append(row);
  });
  return box;
}

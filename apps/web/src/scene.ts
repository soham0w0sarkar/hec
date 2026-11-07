/** 16:9 frame. CSS scales it up with image-rendering: pixelated. */
export const WORLD_W = 480;
export const WORLD_H = 270;

type Ctx = CanvasRenderingContext2D;

// Golden-hour palette. Every pixel in the scene comes from this list.
const PAL = {
  night: "#2a1b3d",
  dusk: "#4b2e5c",
  mauve: "#7a4a7a",
  rose: "#b5668a",
  coral: "#e88f8f",
  peach: "#f7b98a",
  goldDark: "#d68a4a",
  apricot: "#ffd9a0",
  sun: "#ffe4a8",
  sunCore: "#fff3d1",
  star: "#fff6e0",
  starDim: "#8e7bb0",
  cloud: "#ffd6c8",
  cloudShade: "#e39bb0",
  hillFar: "#8a5f8e",
  hillMid: "#5e4a84",
  hillNear: "#3b3266",
  silhouette: "#2b2140",
  roof: "#3d2a58",
  teal: "#2c5d5c",
  tealDark: "#224a4d",
  path: "#8a6244",
  pathShade: "#5c4030",
  wood: "#4a3024",
  glow: "#ffd27a",
  heart: "#f2708f",
  heartSoft: "#f7a1b6",
  skin: "#f0bd98",
  hair: "#2b2140",
  hairWarm: "#4a3350",
  shirtA: "#e0768f",
  shirtB: "#6fa3c7",
  pants: "#3b2d55",
  eye: "#2b2140",
} as const;

/** Sky gradient, top to horizon. Adjacent stops are blended with ordered dithering. */
const HORIZON = 188;
const GROUND_Y = 212;
const COTTAGE = { x: 300, roofY: 140, eaveY: 164, w: 48 };
const COUPLE_X = 168;
const COUPLE_SCALE = 2;

type SkyPhase = "night" | "dawn" | "day" | "dusk";

/** NOW follows the clock. The others lock the meadow on that time of day. */
export const TIMES = [
  { id: "auto", label: "NOW", name: "the clock" },
  { id: "dawn", label: "DAWN", name: "Dawn" },
  { id: "day", label: "DAY", name: "Day" },
  { id: "dusk", label: "EVE", name: "Evening" },
  { id: "night", label: "NIGHT", name: "Night" },
] as const;

export type SkyChoice = (typeof TIMES)[number]["id"];

const SKIES: Record<SkyPhase, readonly string[]> = {
  night: ["#100a18", "#18122c", "#221838", "#2a1d40", "#322448"],
  dawn: ["#2a1b3d", "#6a3d68", "#c46b86", "#f0a888", "#ffd2a4"],
  day: ["#6aabe0", "#8ec8ef", "#f6e2c4", "#ffe7b8", "#fff6df"],
  dusk: [PAL.night, PAL.dusk, PAL.mauve, PAL.rose, PAL.coral, PAL.peach, PAL.apricot],
};

/** The sky the still frame was last painted with. Sun stripes sample it. */
let activeSky: readonly string[] = SKIES.dusk;

/** The phase the clock last resolved. The sky button draws this while it is on auto. */
let clockPhase: SkyPhase = "day";

// 4x4 Bayer matrix for ordered dithering.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const HEART = ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"];

type Cloud = { x: number; y: number; scale: number; speed: number };

const CLOUDS: Cloud[] = [
  { x: 50, y: 74, scale: 1, speed: 0.1 },
  { x: 270, y: 98, scale: 0.7, speed: 0.07 },
];

const STARS = Array.from({ length: 16 }, (_, i) => ({
  x: (i * 89 + 17) % WORLD_W,
  y: 6 + ((i * 37) % 70),
  phase: i * 3,
}));

const FIREFLIES = [
  { x: 56, y: 228 },
  { x: 96, y: 244 },
  { x: 128, y: 224 },
  { x: 214, y: 236 },
  { x: 262, y: 226 },
  { x: 402, y: 240 },
  { x: 436, y: 222 },
  { x: 330, y: 250 },
];

/** The three places in the world. The door and the path open the first two. The menu keeps all three. */
export const PLACES = [
  {
    id: "chat",
    label: "CHAT",
    line: "Ask a question.",
  },
  {
    id: "timeline",
    label: "TIMELINE",
    line: "Milestones stand along the path in date order. Each one opens the messages it came from.",
  },
  {
    id: "stats",
    label: "STATS",
    line: "Streaks, the busiest days, and who writes first are counted here.",
  },
] as const;

export type PlaceId = (typeof PLACES)[number]["id"];
export type Screen = "world" | PlaceId;

export type Hover = "door" | "path" | "icon" | "sky" | SkyChoice;

export type WorldState = {
  screen: Screen;
  /** The choice list is closed until the heart button opens it. */
  board: boolean;
  /** Index into PLACES while the board is open. */
  selected: number;
  /** What the pointer is over, so the scene can name itself. */
  hover: Hover | null;
  /** auto follows the clock. Any other choice holds the sky there. */
  sky: SkyChoice;
  /** The sky icons stay hidden until this button opens them. */
  skyOpen: boolean;
};

export type Hit =
  | { kind: "door" | "path" | "icon" | "sky" }
  | { kind: "place"; index: number }
  | { kind: "time"; id: SkyChoice }
  | { kind: "back" };

const FONT = "8px 'Press Start 2P'";

type Box = { x: number; y: number; w: number; h: number };

/**
 * The part of the world the window shows, in world pixels. A tall or narrow window crops the
 * sides or top and bottom of the scene, so the HUD is anchored to this rather than to the world.
 */
export const view = { left: 0, top: 0, right: WORLD_W, bottom: WORLD_H };

export function setView(next: { left: number; top: number; right: number; bottom: number }): void {
  Object.assign(view, next);
}

const ROW_H = 16;
const BOARD_W = 104;
const BOARD_H = 56;

/** Heart button in the bottom-left of what is on screen. */
function iconBox(): Box {
  return { x: Math.round(view.left + 12), y: Math.round(view.bottom - 12 - 24), w: 24, h: 24 };
}

/** The choice list opens just above the heart button. */
function boardBox(): Box {
  const icon = iconBox();
  return { x: icon.x, y: icon.y - 6 - BOARD_H, w: BOARD_W, h: BOARD_H };
}

export function mountWorld(canvas: HTMLCanvasElement, read: () => WorldState): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas is unavailable");
  canvas.width = WORLD_W;
  canvas.height = WORLD_H;
  ctx.imageSmoothingEnabled = false;

  const still = document.createElement("canvas");
  still.width = WORLD_W;
  still.height = WORLD_H;
  const stillCtx = still.getContext("2d");
  if (!stillCtx) throw new Error("canvas is unavailable");
  let phase = skyPhase();
  let checkedHour = -1;
  let checkedAt = 0;
  drawStill(stillCtx, phase);

  let frame = 0;
  let last = 0;
  let raf = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const paint = () => {
    const state = read();
    let next: SkyPhase = phase;
    if (state.sky === "auto") {
      const now = Date.now();
      if (checkedHour === -1 || now - checkedAt >= 60_000) {
        checkedAt = now;
        const hour = kolkataHour(new Date());
        if (hour !== checkedHour) {
          checkedHour = hour;
          clockPhase = skyPhase();
          next = clockPhase;
        }
      }
    } else {
      next = state.sky;
      checkedHour = -1;
    }
    if (next !== phase) {
      phase = next;
      drawStill(stillCtx, phase);
    }
    ctx.drawImage(still, 0, 0);
    drawLive(ctx, frame, phase);
    const pets = roamPets(frame, phase);
    meow(ctx, frame, pets.cat);
    doggo(ctx, frame, pets.dog);
    if (state.screen === "world") {
      if (phase === "day") idleHeart(ctx, frame);
      couple(ctx, frame, phase);
      petHearts(ctx, frame, pets);
    }
    drawInterface(ctx, frame, state);
    if (state.screen !== "world") seatedCouple(frame);
  };

  const loop = (time: number) => {
    if (!reduced && time - last > 120) {
      last = time;
      frame += 1;
    }
    paint();
    raf = requestAnimationFrame(loop);
  };

  paint();
  raf = requestAnimationFrame(loop);
  // The sign is part of the still frame, so it has to be painted again once the pixel font is ready.
  void document.fonts.load(FONT).then(() => {
    drawStill(stillCtx, phase);
    paint();
  });
  return () => cancelAnimationFrame(raf);
}

/** World pixel under a click, so the canvas can be scaled by CSS and still hit the sign. */
export function worldPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * WORLD_W,
    y: ((clientY - rect.top) / rect.height) * WORLD_H,
  };
}

export function hitTest(x: number, y: number, state: WorldState): Hit | null {
  if (state.screen === "world") {
    if (state.board) {
      const index = PLACES.findIndex((_, i) => inside(x, y, rowBox(i)));
      if (index !== -1) return { kind: "place", index };
    }
    if (inside(x, y, iconBox())) return { kind: "icon" };
    if (state.skyOpen) {
      const time = timeBoxes().find((item) => inside(x, y, item.box));
      if (time) return { kind: "time", id: time.id };
    }
    if (inside(x, y, skyButtonBox())) return { kind: "sky" };
    if (inside(x, y, doorBox())) return { kind: "door" };
    if (inside(x, y, pathBox())) return { kind: "path" };
    return null;
  }
  return null;
}

/** The cottage door. A little larger than the painted opening, so it is easy to hit. */
function doorBox(): Box {
  const { x, w } = COTTAGE;
  return { x: x + w / 2 - 10, y: GROUND_Y - 22, w: 20, h: 28 };
}

/** The signpost and the lamp posts. Kept clear of the heart button in the corner. */
function pathBox(): Box {
  return { x: 236, y: GROUND_Y - 34, w: 70, h: 78 };
}

const SKY_BUTTON = 24;
const SKY_CHOICE = 20;
const SKY_GAP = 3;

/** One button in the bottom-right. The choices sit beside it only while it is open. */
function skyButtonBox(): Box {
  return {
    x: Math.round(view.right - 12 - SKY_BUTTON),
    y: Math.round(view.bottom - 12 - SKY_BUTTON),
    w: SKY_BUTTON,
    h: SKY_BUTTON,
  };
}

function timeBoxes(): { id: SkyChoice; box: Box }[] {
  const anchor = skyButtonBox();
  const span = TIMES.length * SKY_CHOICE + (TIMES.length - 1) * SKY_GAP;
  const rowX = anchor.x - SKY_GAP - span;
  if (rowX >= Math.round(view.left + 44)) {
    let x = rowX;
    const y = anchor.y + Math.round((SKY_BUTTON - SKY_CHOICE) / 2);
    return TIMES.map((item) => {
      const box = { x, y, w: SKY_CHOICE, h: SKY_CHOICE };
      x += SKY_CHOICE + SKY_GAP;
      return { id: item.id, box };
    });
  }
  let y = anchor.y - SKY_GAP - span;
  const x = anchor.x + Math.round((SKY_BUTTON - SKY_CHOICE) / 2);
  return TIMES.map((item) => {
    const box = { x, y, w: SKY_CHOICE, h: SKY_CHOICE };
    y += SKY_CHOICE + SKY_GAP;
    return { id: item.id, box };
  });
}

function rowBox(index: number): Box {
  const board = boardBox();
  return { x: board.x + 4, y: board.y + 4 + index * ROW_H, w: board.w - 8, h: ROW_H - 2 };
}

function inside(x: number, y: number, box: { x: number; y: number; w: number; h: number }): boolean {
  return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
}

/** Everything that never moves. Rebuilt when the time of day changes. */
function drawStill(ctx: Ctx, phase: SkyPhase): void {
  activeSky = SKIES[phase];
  sky(ctx);
  sun(ctx, phase);
  hills(ctx);
  meadow(ctx);
  way(ctx);
  cottage(ctx, phase);
}

/** Everything that moves, drawn over a fresh copy of the still frame. */
function drawLive(ctx: Ctx, frame: number, phase: SkyPhase): void {
  stars(ctx, frame, phase);
  for (const cloud of CLOUDS) {
    const span = WORLD_W + 90;
    const x = ((cloud.x + frame * cloud.speed) % span) - 45;
    cloudAt(ctx, x, cloud.y, cloud.scale);
  }
  smoke(ctx, frame);
  if (phase === "dusk" || phase === "night") fireflies(ctx, frame);
  greeter(ctx, frame);
}

/** Hour in Asia/Kolkata. Night is stars, evening is the sunset, daytime is a high sun. */
function skyPhase(now = new Date()): SkyPhase {
  const hour = kolkataHour(now);
  if (hour >= 20 || hour < 5) return "night";
  if (hour < 8) return "dawn";
  if (hour < 16) return "day";
  return "dusk";
}

function kolkataHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0);
}

function sky(ctx: Ctx): void {
  for (let y = 0; y < HORIZON; y++) {
    const f = (y / HORIZON) * (activeSky.length - 1);
    const i = Math.floor(f);
    const t = f - i;
    const a = activeSky[i] ?? PAL.night;
    const b = activeSky[Math.min(i + 1, activeSky.length - 1)] ?? a;
    for (let x = 0; x < WORLD_W; x++) {
      const threshold = ((BAYER[y % 4]?.[x % 4] ?? 0) + 0.5) / 16;
      ctx.fillStyle = t > threshold ? b : a;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** Sky colour at a row, without dithering. Used for the sun's cut-out stripes. */
function skyAt(y: number): string {
  const index = Math.min(activeSky.length - 1, Math.round((y / HORIZON) * (activeSky.length - 1)));
  return activeSky[index] ?? PAL.night;
}

function sun(ctx: Ctx, phase: SkyPhase): void {
  if (phase === "night") {
    moon(ctx);
    return;
  }
  const placed = phase === "day" ? { x: 390, y: 58, r: 14 } : phase === "dawn" ? { x: 64, y: 148, r: 18 } : { x: 402, y: 136, r: 24 };
  const { x: cx, y: cy, r } = placed;

  // Checkered halo: dense close to the disc, sparse farther out.
  for (let y = cy - r - 14; y <= cy + r + 14; y++) {
    for (let x = cx - r - 14; x <= cx + r + 14; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r + 1 || d > r + 14) continue;
      const lit = d <= r + 7 ? (x + y) % 2 === 0 : (x + y) % 4 === 0;
      if (!lit) continue;
      ctx.fillStyle = PAL.sun;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  disc(ctx, cx, cy, r, PAL.sun);
  disc(ctx, cx, cy, r - 8, PAL.sunCore);

  // Retro sunset cut-outs. Daytime keeps a whole disc.
  if (phase !== "day") {
    for (let y = cy + 6; y <= cy + r; y += 3) {
      const w = Math.floor(Math.sqrt(r * r - (y - cy) * (y - cy)));
      ctx.fillStyle = skyAt(y);
      ctx.fillRect(cx - w, y, w * 2, 1);
    }
  }
}

function moon(ctx: Ctx): void {
  disc(ctx, 78, 46, 9, PAL.star);
  disc(ctx, 82, 44, 7, skyAt(44));
}

function stars(ctx: Ctx, frame: number, phase: SkyPhase): void {
  if (phase === "day") return;
  const spark = phase === "night" ? 8 : phase === "dawn" ? 3 : 2;
  for (const star of STARS) {
    const t = (frame + star.phase) % 12;
    if (t < spark) {
      ctx.fillStyle = PAL.star;
      ctx.fillRect(star.x, star.y, 1, 1);
      ctx.fillRect(star.x - 1, star.y, 1, 1);
      ctx.fillRect(star.x + 1, star.y, 1, 1);
      ctx.fillRect(star.x, star.y - 1, 1, 1);
      ctx.fillRect(star.x, star.y + 1, 1, 1);
    } else {
      ctx.fillStyle = PAL.starDim;
      ctx.fillRect(star.x, star.y, 1, 1);
    }
  }
}

function hills(ctx: Ctx): void {
  ridge(ctx, PAL.hillFar, (x) => 178 + 7 * Math.sin(x * 0.017) + 3 * Math.sin(x * 0.063 + 1));
  ridge(ctx, PAL.hillMid, (x) => 193 + 5 * Math.sin(x * 0.023 + 2) + 2 * Math.sin(x * 0.081));
  ridge(ctx, PAL.hillNear, (x) => 204 + 4 * Math.sin(x * 0.019 + 4));
}

function ridge(ctx: Ctx, color: string, top: (x: number) => number): void {
  ctx.fillStyle = color;
  for (let x = 0; x < WORLD_W; x++) {
    const y = Math.round(top(x));
    ctx.fillRect(x, y, 1, WORLD_H - y);
  }
}

function meadow(ctx: Ctx): void {
  ctx.fillStyle = PAL.teal;
  ctx.fillRect(0, GROUND_Y, WORLD_W, WORLD_H - GROUND_Y);
  for (let y = GROUND_Y + 8; y < WORLD_H; y += 10) {
    ctx.fillStyle = PAL.tealDark;
    for (let x = (y * 3) % 12; x < WORLD_W; x += 12) ctx.fillRect(x, y, 6, 2);
  }
}

/** A signpost and three lamp posts, left of the couple and clear of the corner button. */
function way(ctx: Ctx): void {
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const x = Math.round(248 + t * 28);
    const y = Math.round(GROUND_Y + 8 + t * 20);
    ctx.fillStyle = PAL.path;
    ctx.fillRect(x, y, 12, 4);
    ctx.fillStyle = PAL.pathShade;
    ctx.fillRect(x, y + 3, 12, 1);
    if (i === 1 || i === 4 || i === 7) lamp(ctx, x + 14, y - 14);
  }

  const postX = 242;
  const postY = GROUND_Y;
  ctx.fillStyle = PAL.wood;
  ctx.fillRect(postX, postY - 28, 3, 30);
  ctx.fillStyle = PAL.peach;
  ctx.fillRect(postX + 3, postY - 26, 36, 12);
  ctx.font = FONT;
  ctx.textBaseline = "top";
  ctx.fillStyle = PAL.night;
  ctx.fillText("TIME", postX + 6, postY - 24);
}

function lamp(ctx: Ctx, x: number, y: number): void {
  ctx.fillStyle = PAL.wood;
  ctx.fillRect(x, y + 3, 2, 12);
  ctx.fillStyle = PAL.glow;
  ctx.fillRect(x - 1, y, 4, 3);
}

function cottage(ctx: Ctx, phase: SkyPhase): void {
  const { x, roofY, eaveY, w } = COTTAGE;
  const pitch = eaveY - roofY;

  for (let i = 0; i <= pitch; i++) {
    const half = Math.round((i / pitch) * (w / 2 + 3));
    ctx.fillStyle = PAL.roof;
    ctx.fillRect(x + w / 2 - half, roofY + i, half * 2, 1);
  }

  ctx.fillStyle = PAL.silhouette;
  ctx.fillRect(x, eaveY, w, GROUND_Y - eaveY + 4);
  ctx.fillRect(x + w - 14, roofY - 8, 6, 12);

  const windowColor = phase === "day" ? "#d7ecff" : PAL.glow;
  ctx.fillStyle = windowColor;
  ctx.fillRect(x + 8, eaveY + 8, 8, 8);
  ctx.fillRect(x + w - 16, eaveY + 8, 8, 8);
  blitHeart(ctx, x + w / 2 - 3, eaveY + 6, 1, phase === "day" ? PAL.coral : PAL.glow);

  // Door frame, then the dark opening the greeter stands in.
  const doorX = x + w / 2 - 5;
  ctx.fillStyle = PAL.wood;
  ctx.fillRect(doorX, GROUND_Y - 16, 10, 20);
  ctx.fillStyle = PAL.night;
  ctx.fillRect(doorX + 1, GROUND_Y - 15, 8, 19);
}

/** The bot in the doorway. A wave every couple of seconds. */
function greeter(ctx: Ctx, frame: number): void {
  const doorX = COTTAGE.x + Math.floor(COTTAGE.w / 2) - 2;
  const bob = Math.round(Math.sin(frame * 0.25));
  const y = GROUND_Y - 14 + bob;
  ctx.fillStyle = PAL.skin;
  ctx.fillRect(doorX, y, 4, 3);
  ctx.fillStyle = PAL.eye;
  ctx.fillRect(doorX, y + 1, 1, 1);
  ctx.fillRect(doorX + 3, y + 1, 1, 1);
  ctx.fillStyle = PAL.shirtB;
  ctx.fillRect(doorX, y + 3, 4, 6);
  if (frame % 24 < 10) {
    ctx.fillStyle = PAL.skin;
    ctx.fillRect(doorX - 2, y + 4, 2, 2);
  }
}

function cloudAt(ctx: Ctx, x: number, y: number, scale: number): void {
  const parts: [number, number, number][] = [
    [0, 0, 9],
    [12, -5, 12],
    [26, -1, 10],
    [36, 2, 7],
  ];
  for (const [dx, dy, r] of parts) {
    disc(ctx, Math.round(x + dx * scale), Math.round(y + dy * scale), Math.round(r * scale), PAL.cloud);
  }
  ctx.fillStyle = PAL.cloudShade;
  ctx.fillRect(Math.round(x - 6 * scale), Math.round(y + 7 * scale), Math.round(46 * scale), 2);
}

function smoke(ctx: Ctx, frame: number): void {
  const sx = COTTAGE.x + COTTAGE.w - 11;
  const sy = COTTAGE.roofY - 9;
  ctx.fillStyle = PAL.starDim;
  for (let i = 0; i < 3; i++) {
    const t = (frame + i * 10) % 30;
    if (t > 22) continue;
    const drift = Math.round(Math.sin((frame + i * 10) * 0.25) * 2);
    ctx.fillRect(sx + drift, sy - t, 2, 2);
  }
}

function fireflies(ctx: Ctx, frame: number): void {
  FIREFLIES.forEach((fly, i) => {
    if ((frame + i * 7) % 16 >= 6) return;
    ctx.fillStyle = PAL.glow;
    ctx.fillRect(fly.x, fly.y, 1, 1);
  });
}

type Face = 1 | -1;

/** Feet position in world pixels. */
type Stop = { x: number; y: number };

type Region = { minX: number; maxX: number; minY: number; maxY: number };

type Seg = { from: Stop; to: Stop; start: number; walk: number; end: number; visit: boolean; dir: Face };

/** A pet's random walk. Segments are made lazily, as the frame counter reaches them. */
type Roamer = {
  spot: Stop;
  region: Region;
  visit: Stop;
  visitFace: Face;
  cursor: number;
  segs: Seg[];
  /** The sky the current walk was built for. A change starts a new walk from here. */
  sky: SkyPhase | null;
};

type PetPose = "walk" | "stand" | "stretch" | "sit" | "sleep" | "play";

type Pet = { x: number; y: number; face: Face; walking: boolean; visit: boolean; pose: PetPose };

const PACE: Record<SkyPhase, { visit: number; hold: number; extra: number; speed: number }> = {
  dawn: { visit: 0.1, hold: 18, extra: 20, speed: 1 },
  day: { visit: 0.22, hold: 10, extra: 24, speed: 1.5 },
  dusk: { visit: 0.35, hold: 28, extra: 24, speed: 0.8 },
  night: { visit: 0, hold: 220, extra: 40, speed: 1 },
};

/** Sprite size in units. Each unit is PET_SCALE world pixels. */
const CAT = { w: 14, h: 12 };
const DOG = { w: 16, h: 14 };
const PET_SCALE = 2;

const CAT_ROAM: Roamer = {
  spot: { x: 60, y: 246 },
  region: { minX: 24, maxX: 150, minY: 236, maxY: 254 },
  visit: { x: 130, y: 240 },
  visitFace: 1,
  cursor: 0,
  segs: [],
  sky: null,
};

const DOG_ROAM: Roamer = {
  spot: { x: 300, y: 246 },
  region: { minX: 250, maxX: 420, minY: 236, maxY: 254 },
  visit: { x: 222, y: 242 },
  visitFace: -1,
  cursor: 0,
  segs: [],
  sky: null,
};

function randomStop(region: Region): Stop {
  return {
    x: Math.round(region.minX + Math.random() * (region.maxX - region.minX)),
    y: Math.round(region.minY + Math.random() * (region.maxY - region.minY)),
  };
}

/** Pick the next leg. At night they settle and stay; the other times they wander their patch. */
function addSeg(r: Roamer): void {
  const pace = PACE[r.sky ?? "day"];
  const last = r.segs[r.segs.length - 1];
  const from = last ? last.to : r.spot;
  const region = r.sky === "night" ? { minX: from.x, maxX: from.x, minY: from.y, maxY: from.y } : r.region;
  const visit = r.sky !== "night" && Math.random() < pace.visit;
  const to = visit ? r.visit : randomStop(region);
  const dx = to.x - from.x;
  const walk = Math.max(4, Math.round(Math.hypot(dx, to.y - from.y) / pace.speed));
  const hold = visit ? 40 + Math.floor(Math.random() * 40) : pace.hold + Math.floor(Math.random() * pace.extra);
  const dir: Face = Math.abs(dx) < 1 ? (last?.dir ?? 1) : dx < 0 ? -1 : 1;
  const seg: Seg = { from, to, start: r.cursor, walk, end: r.cursor + walk + hold, visit, dir };
  r.segs.push(seg);
  r.cursor = seg.end;
}

function spotNow(r: Roamer, frame: number): Stop {
  let seg: Seg | undefined;
  for (let i = r.segs.length - 1; i >= 0; i--) {
    const item = r.segs[i];
    if (item && item.start <= frame) {
      seg = item;
      break;
    }
  }
  if (!seg) return r.spot;
  const into = frame - seg.start;
  const u = into < seg.walk ? into / seg.walk : 1;
  return {
    x: Math.round(seg.from.x + (seg.to.x - seg.from.x) * u),
    y: Math.round(seg.from.y + (seg.to.y - seg.from.y) * u),
  };
}

function poseFor(phase: SkyPhase, walking: boolean, visit: boolean): PetPose {
  if (phase === "night" && !walking) return "sleep";
  if (walking) return "walk";
  if (visit) return "play";
  if (phase === "dawn") return "stretch";
  if (phase === "dusk") return "sit";
  return "stand";
}

/** Where a pet is on this frame. A new time of day drops the old route and starts from here. */
function roam(r: Roamer, frame: number, phase: SkyPhase): Pet {
  if (r.sky !== phase) {
    r.spot = spotNow(r, frame);
    r.segs = [];
    r.cursor = frame;
    r.sky = phase;
  }
  while (r.cursor <= frame) addSeg(r);
  let seg: Seg | undefined;
  for (let i = r.segs.length - 1; i >= 0; i--) {
    const item = r.segs[i];
    if (item && item.start <= frame) {
      seg = item;
      break;
    }
  }
  if (!seg) return { x: r.spot.x, y: r.spot.y, face: 1, walking: false, visit: false, pose: poseFor(phase, false, false) };
  const into = frame - seg.start;
  const walking = into < seg.walk;
  const visit = !walking && seg.visit;
  return {
    ...spotNow(r, frame),
    face: visit ? r.visitFace : seg.dir,
    walking,
    visit,
    pose: poseFor(phase, walking, visit),
  };
}

/** Keep a pet out of the corner buttons when its body crosses that row. */
function clearButtons(x: number, feet: number, w: number, h: number): number {
  const top = feet - h;
  const buttonTop = Math.round(view.bottom - 12 - 24);
  if (top > buttonTop + 24 || feet < buttonTop) return x;
  const heartRight = Math.round(view.left + 12 + 24);
  const skyLeft = Math.round(view.right - 12 - 24);
  if (heartRight + w + 12 >= skyLeft) return x;
  if (x < heartRight + 6) return heartRight + 6;
  if (x + w > skyLeft - 6) return skyLeft - 6 - w;
  return x;
}

/** Where the cat and the dog are this frame, nudged off the corner buttons. */
function roamPets(frame: number, phase: SkyPhase): { cat: Pet; dog: Pet } {
  const cat = roam(CAT_ROAM, frame, phase);
  const dog = roam(DOG_ROAM, frame, phase);
  return {
    cat: { ...cat, x: clearButtons(cat.x, cat.y, CAT.w * PET_SCALE, CAT.h * PET_SCALE) },
    dog: { ...dog, x: clearButtons(dog.x, dog.y, DOG.w * PET_SCALE, DOG.h * PET_SCALE) },
  };
}

/** Hearts float up while a pet is with the couple. */
function petHearts(ctx: Ctx, frame: number, pets: { cat: Pet; dog: Pet }): void {
  if (pets.cat.visit) {
    heartBubbles(ctx, pets.cat.x + 14, pets.cat.y - CAT.h * PET_SCALE - 2, frame);
  }
  if (pets.dog.visit) {
    heartBubbles(ctx, pets.dog.x + 20, pets.dog.y - DOG.h * PET_SCALE - 2, frame + 6);
  }
}

function heartBubbles(ctx: Ctx, x: number, y: number, frame: number): void {
  const columns = [-8, 2, 12];
  for (let i = 0; i < columns.length; i++) {
    const t = (frame + i * 14) % 40;
    if (t > 24) continue;
    blitHeart(ctx, x + (columns[i] ?? 0), y - t, 1, i === 1 ? PAL.heartSoft : PAL.heart);
  }
}

/**
 * Four legs in two diagonal pairs. While walking, one pair lifts, then the other,
 * so the body rolls forward instead of stepping on two legs.
 */
function gait(frame: number, walking: boolean): { lift: (pair: 0 | 1) => boolean } {
  const phase = Math.floor(frame / 3) % 2;
  return { lift: (pair) => walking && phase === pair };
}

/** Draw one unit-rect in a sprite, mirrored when the pet faces left. */
function unit(ctx: Ctx, pet: Pet, width: number, top: number, dx: number, dy: number, w: number, h: number, color: string): void {
  const sx = pet.face === 1 ? dx : width - dx - w;
  ctx.fillStyle = color;
  ctx.fillRect(pet.x + sx * PET_SCALE, top + dy * PET_SCALE, w * PET_SCALE, h * PET_SCALE);
}

/** A small z that rises and fades, one at a time, over a sleeping pet. */
function sleepZ(ctx: Ctx, x: number, y: number, frame: number): void {
  const t = frame % 28;
  if (t > 16) return;
  ctx.fillStyle = PAL.star;
  ctx.fillRect(x, y - t, 3, 1);
  ctx.fillRect(x + 2, y - t + 1, 1, 1);
  ctx.fillRect(x, y - t + 2, 3, 1);
}

function doggo(ctx: Ctx, frame: number, pet: Pet): void {
  if (pet.pose === "sleep") {
    dogSleep(ctx, frame, pet);
    return;
  }
  if (pet.pose === "sit") {
    dogSit(ctx, pet);
    return;
  }
  if (pet.pose === "stretch") {
    dogStretch(ctx, frame, pet);
    return;
  }
  const top = pet.y - DOG.h * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, DOG.w, top, dx, dy, w, h, color);
  const { lift } = gait(frame, pet.walking);
  const foot = (pair: 0 | 1) => (lift(pair) ? 12 : 14) - 9;

  // Far legs are darker so they sit behind the body.
  put(2, 9, 2, foot(0), PAL.goldDark);
  put(8, 9, 2, foot(1), PAL.goldDark);

  // Tail: a feathered plume that swings up and down.
  const up = Math.floor(frame / (pet.pose === "play" ? 4 : 8)) % 2 === 0;
  put(0, up ? 1 : 4, 2, 3, PAL.glow);
  put(0, up ? 1 : 4, 1, 1, PAL.sun);

  put(2, 4, 9, 5, PAL.glow);
  put(8, 6, 3, 3, PAL.sun);

  // Near legs.
  put(5, 9, 2, foot(1), PAL.glow);
  put(11, 9, 2, foot(0), PAL.glow);

  // Floppy ear: long, darker gold, hanging behind the head.
  put(8, 1, 2, 7, PAL.goldDark);

  // Head, muzzle, and face.
  put(10, 1, 5, 5, PAL.glow);
  put(13, 3, 3, 2, PAL.sun);
  put(15, 3, 1, 1, PAL.eye);
  const blink = frame % 48 < 2;
  put(12, 2, 1, 1, blink ? PAL.glow : PAL.eye);
  if (pet.pose === "play") put(14, 5, 2, 1, PAL.heart);
}

/** Haunches down, front paws out, ear hanging, tongue out. */
function dogSit(ctx: Ctx, pet: Pet): void {
  const top = pet.y - 12 * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, DOG.w, top, dx, dy, w, h, color);
  put(1, 3, 2, 3, PAL.glow);
  put(3, 4, 7, 5, PAL.glow);
  put(6, 6, 3, 3, PAL.sun);
  put(4, 9, 2, 3, PAL.glow);
  put(8, 9, 2, 3, PAL.glow);
  put(8, 2, 2, 7, PAL.goldDark);
  put(10, 2, 4, 5, PAL.glow);
  put(13, 4, 3, 2, PAL.sun);
  put(15, 4, 1, 1, PAL.eye);
  put(12, 3, 1, 1, PAL.eye);
  put(14, 6, 2, 1, PAL.heart);
}

/** Play bow: chest low, rear and tail up, held for half the beat. */
function dogStretch(ctx: Ctx, frame: number, pet: Pet): void {
  const bow = Math.floor(frame / 12) % 2 === 1;
  if (!bow) {
    doggoStand(ctx, frame, pet);
    return;
  }
  const top = pet.y - DOG.h * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, DOG.w, top, dx, dy, w, h, color);
  put(0, 1, 2, 3, PAL.glow);
  put(2, 3, 5, 4, PAL.glow);
  put(7, 6, 4, 3, PAL.sun);
  put(11, 6, 4, 2, PAL.glow);
  put(9, 3, 2, 6, PAL.goldDark);
  put(12, 4, 3, 4, PAL.glow);
  put(14, 5, 1, 1, PAL.eye);
  put(4, 7, 2, 6, PAL.glow);
  put(8, 9, 2, 4, PAL.glow);
}

function doggoStand(ctx: Ctx, frame: number, pet: Pet): void {
  doggo(ctx, frame, { ...pet, pose: "stand" });
}

function dogSleep(ctx: Ctx, frame: number, pet: Pet): void {
  const top = pet.y - 8 * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, DOG.w, top, dx, dy, w, h, color);
  put(1, 3, 9, 4, PAL.glow);
  put(6, 5, 3, 2, PAL.sun);
  put(9, 2, 5, 4, PAL.glow);
  put(8, 4, 6, 2, PAL.goldDark);
  put(12, 3, 1, 1, PAL.eye);
  put(2, 7, 2, 1, PAL.glow);
  put(6, 7, 2, 1, PAL.glow);
  sleepZ(ctx, pet.x + (pet.face === 1 ? 28 : 0), top, frame);
}

function meow(ctx: Ctx, frame: number, pet: Pet): void {
  if (pet.pose === "sleep") {
    catSleep(ctx, frame, pet);
    return;
  }
  if (pet.pose === "stretch") {
    catStretch(ctx, frame, pet);
    return;
  }
  if (pet.pose === "sit") {
    catSit(ctx, frame, pet);
    return;
  }
  const top = pet.y - CAT.h * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, CAT.w, top, dx, dy, w, h, color);
  const { lift } = gait(frame, pet.walking);
  const foot = (pair: 0 | 1) => (lift(pair) ? 11 : 12) - 9;

  put(3, 9, 1, foot(0), PAL.peach);
  put(7, 9, 1, foot(1), PAL.peach);

  const tailUp = Math.floor(frame / 16) % 2 === 0;
  put(0, tailUp ? 2 : 5, 2, 3, PAL.apricot);
  put(1, tailUp ? 4 : 5, 2, 2, PAL.apricot);

  put(3, 5, 7, 4, PAL.apricot);

  put(5, 9, 1, foot(1), PAL.apricot);
  put(9, 9, 1, foot(0), PAL.apricot);

  put(9, 2, 4, 5, PAL.apricot);
  put(9, 0, 2, 2, PAL.apricot);
  put(12, 0, 2, 2, PAL.apricot);
  put(10, 1, 1, 1, PAL.heartSoft);
  put(12, 1, 1, 1, PAL.heartSoft);
  const blink = frame % 48 < 2;
  put(10, 4, 1, 1, blink ? PAL.apricot : PAL.eye);
  put(12, 4, 1, 1, blink ? PAL.apricot : PAL.eye);
  put(13, 5, 1, 1, PAL.heart);
}

function catSit(ctx: Ctx, frame: number, pet: Pet): void {
  const top = pet.y - 10 * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, CAT.w, top, dx, dy, w, h, color);
  const tailUp = Math.floor(frame / 16) % 2 === 0;
  put(0, tailUp ? 2 : 4, 2, 3, PAL.apricot);
  put(2, 4, 8, 4, PAL.apricot);
  put(8, 1, 4, 5, PAL.apricot);
  put(8, 0, 2, 2, PAL.apricot);
  put(11, 0, 2, 2, PAL.apricot);
  put(9, 3, 1, 1, PAL.eye);
  put(11, 3, 1, 1, PAL.eye);
  put(12, 4, 1, 1, PAL.heart);
}

function catStretch(ctx: Ctx, frame: number, pet: Pet): void {
  const reach = Math.floor(frame / 12) % 2 === 1;
  const top = pet.y - (reach ? 8 : 10) * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, CAT.w, top, dx, dy, w, h, color);
  put(0, 0, 2, reach ? 5 : 3, PAL.apricot);
  put(2, reach ? 4 : 3, 8, 3, PAL.apricot);
  put(9, reach ? 3 : 1, 4, 4, PAL.apricot);
  put(9, reach ? 1 : 0, 2, 2, PAL.apricot);
  put(12, reach ? 2 : 0, 2, 2, PAL.apricot);
  if (!reach) {
    put(10, 3, 1, 1, PAL.eye);
    put(12, 3, 1, 1, PAL.eye);
  }
  put(13, reach ? 5 : 4, 1, 1, PAL.heart);
}

function catSleep(ctx: Ctx, frame: number, pet: Pet): void {
  const top = pet.y - 8 * PET_SCALE;
  const put = (dx: number, dy: number, w: number, h: number, color: string) =>
    unit(ctx, pet, CAT.w, top, dx, dy, w, h, color);
  put(0, 3, 3, 2, PAL.apricot);
  put(2, 3, 8, 4, PAL.apricot);
  put(8, 1, 4, 4, PAL.apricot);
  put(8, 0, 2, 2, PAL.apricot);
  put(11, 0, 2, 2, PAL.apricot);
  put(12, 3, 1, 1, PAL.heart);
  sleepZ(ctx, pet.x + (pet.face === 1 ? 24 : 2), top - 2, frame);
}

function couple(ctx: Ctx, frame: number, phase: SkyPhase): void {
  const blink = frame % 40 === 39;
  const breath = frame % 32 < 16 ? -1 : 0;
  if (phase === "dawn") {
    const stretch = Math.floor(frame / 12) % 4;
    const arms = stretch === 0 ? "down" : stretch === 2 ? "up" : "mid";
    const y = GROUND_Y - 22 * COUPLE_SCALE;
    person(ctx, COUPLE_X, y, PAL.shirtA, PAL.hair, blink || arms === "up", COUPLE_SCALE, { arms });
    person(ctx, COUPLE_X + 28, y, PAL.shirtB, PAL.hairWarm, blink, COUPLE_SCALE, { gaze: "left" });
    mug(ctx, COUPLE_X + 24, y + 11 * COUPLE_SCALE, frame);
    return;
  }
  if (phase === "day") {
    const step = (Math.floor(frame / 6) % 4) as 0 | 1 | 2 | 3;
    const y = GROUND_Y - 22 * COUPLE_SCALE + (step % 2 === 1 ? COUPLE_SCALE : 0);
    person(ctx, COUPLE_X, y, PAL.shirtA, PAL.hair, blink, COUPLE_SCALE, { step });
    person(ctx, COUPLE_X + 28, y, PAL.shirtB, PAL.hairWarm, blink, COUPLE_SCALE, { gaze: "left", step });
    return;
  }
  if (phase === "dusk") {
    const y = GROUND_Y - 18 * COUPLE_SCALE + breath;
    sit(ctx, COUPLE_X, y, PAL.shirtA, PAL.hair, blink, COUPLE_SCALE, "right");
    sit(ctx, COUPLE_X + 28, y, PAL.shirtB, PAL.hairWarm, blink, COUPLE_SCALE, "right");
    return;
  }
  const y = GROUND_Y - 18 * COUPLE_SCALE + breath;
  sit(ctx, COUPLE_X + 6, y, PAL.shirtA, PAL.hair, blink, COUPLE_SCALE, "right");
  sit(ctx, COUPLE_X + 22, y, PAL.shirtB, PAL.hairWarm, blink, COUPLE_SCALE, "left");
  blanket(ctx, COUPLE_X + 4, GROUND_Y - 8 * COUPLE_SCALE);
  lantern(ctx, COUPLE_X + 48, GROUND_Y - 12, frame);
}

const PERCH_W = 72;
const PERCH_H = 36;
const PERCH_SEAT = 20;

/** Perched on the open panel: hips on its top edge, legs over the frame. */
function seatedCouple(frame: number): void {
  const perch = document.querySelector<HTMLCanvasElement>("#perch");
  if (!perch) return;
  const scale = Math.max(window.innerWidth / WORLD_W, window.innerHeight / WORLD_H);
  if (perch.width !== PERCH_W) {
    perch.width = PERCH_W;
    perch.height = PERCH_H;
  }
  perch.style.width = `${PERCH_W * scale}px`;
  perch.style.height = `${PERCH_H * scale}px`;
  perch.style.transform = `translate(-50%, ${-PERCH_SEAT * scale}px)`;

  const ctx = perch.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, PERCH_W, PERCH_H);

  const bob = frame % 16 === 0 ? -1 : 0;
  const seat = PERCH_SEAT + bob;
  const gap = 4;
  const pair = 12 + gap + 12;
  const x = Math.round((PERCH_W - pair) / 2);
  const blink = frame % 14 === 13;
  seated(ctx, x, seat, PAL.shirtA, PAL.hair, blink);
  seated(ctx, x + 12 + gap, seat, PAL.shirtB, PAL.hairWarm, blink, "left");
  blitHeart(ctx, x - 12, seat - 12, 1, PAL.heart);
  blitHeart(ctx, x + pair + 4, seat - 10, 1, PAL.heartSoft);
}

function seated(
  ctx: Ctx,
  x: number,
  seat: number,
  shirt: string,
  hair: string,
  blink: boolean,
  gaze: Gaze = "forward",
): void {
  const y = seat - 16;
  ctx.fillStyle = hair;
  ctx.fillRect(x + 2, y, 8, 3);
  ctx.fillStyle = PAL.skin;
  ctx.fillRect(x + 2, y + 3, 8, 5);
  face(ctx, x, y, hair, blink, gaze, 1);
  ctx.fillStyle = shirt;
  ctx.fillRect(x, y + 8, 12, 8);
  ctx.fillStyle = PAL.pants;
  ctx.fillRect(x + 2, seat, 2, 6);
  ctx.fillRect(x + 8, seat, 2, 6);
  ctx.fillRect(x + 1, seat + 6, 3, 2);
  ctx.fillRect(x + 8, seat + 6, 3, 2);
}

/** One heart rises over the walk, then the meadow is quiet. */
function idleHeart(ctx: Ctx, frame: number): void {
  const cycle = 56;
  const t = frame % cycle;
  if (t > 28) return;
  blitHeart(ctx, COUPLE_X + 18 + Math.round(Math.sin(t * 0.25)), GROUND_Y - 50 - t, 2, PAL.heart);
}

type Gaze = "forward" | "left" | "right";

type Pose = { gaze?: Gaze; step?: 0 | 1 | 2 | 3; arms?: "down" | "mid" | "up" };

function person(
  ctx: Ctx,
  x: number,
  y: number,
  shirt: string,
  hair: string,
  blink: boolean,
  scale = 1,
  pose: Pose = {},
): void {
  const stamp = (dx: number, dy: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + dx * scale, y + dy * scale, w * scale, h * scale);
  };
  const gaze = pose.gaze ?? "forward";
  stamp(2, 0, 8, 3, hair);
  stamp(2, 3, 8, 5, PAL.skin);
  face(ctx, x, y, hair, blink, gaze, scale);
  stamp(0, 8, 12, 8, shirt);
  if (pose.arms === "up") {
    stamp(0, -6, 2, 14, shirt);
    stamp(10, -6, 2, 14, shirt);
  } else if (pose.arms === "mid") {
    stamp(0, -1, 2, 8, shirt);
    stamp(10, -1, 2, 8, shirt);
  }
  const step = pose.step;
  if (step === 1) {
    stamp(0, 16, 2, 6, PAL.pants);
    stamp(8, 16, 2, 6, PAL.pants);
  } else if (step === 3) {
    stamp(2, 16, 2, 6, PAL.pants);
    stamp(10, 16, 2, 6, PAL.pants);
  } else {
    stamp(2, 16, 2, 6, PAL.pants);
    stamp(8, 16, 2, 6, PAL.pants);
  }
}

/** On the grass: body upright, legs out in front. */
function sit(
  ctx: Ctx,
  x: number,
  y: number,
  shirt: string,
  hair: string,
  blink: boolean,
  scale: number,
  gaze: Gaze,
): void {
  const stamp = (dx: number, dy: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + dx * scale, y + dy * scale, w * scale, h * scale);
  };
  stamp(2, 0, 8, 3, hair);
  stamp(2, 3, 8, 5, PAL.skin);
  face(ctx, x, y, hair, blink, gaze, scale);
  stamp(0, 8, 12, 7, shirt);
  stamp(2, 14, 8, 3, PAL.pants);
  stamp(9, 15, 2, 2, PAL.pants);
}

function mug(ctx: Ctx, x: number, y: number, frame: number): void {
  ctx.fillStyle = PAL.apricot;
  ctx.fillRect(x, y, 6, 5);
  ctx.fillStyle = PAL.peach;
  ctx.fillRect(x + 5, y + 1, 2, 3);
  const puff = frame % 16;
  if (puff < 10) {
    ctx.fillStyle = PAL.star;
    ctx.fillRect(x + 2, y - 2 - puff, 1, 1);
  }
}

function blanket(ctx: Ctx, x: number, y: number): void {
  ctx.fillStyle = PAL.mauve;
  ctx.fillRect(x, y, 52, 8);
  ctx.fillStyle = PAL.heart;
  ctx.fillRect(x + 24, y + 3, 3, 2);
}

function lantern(ctx: Ctx, x: number, y: number, frame: number): void {
  ctx.fillStyle = PAL.wood;
  ctx.fillRect(x + 1, y, 4, 2);
  ctx.fillRect(x + 2, y + 6, 2, 4);
  ctx.fillStyle = frame % 28 < 4 ? PAL.sun : PAL.glow;
  ctx.fillRect(x, y + 2, 6, 4);
}

/** Two eyes straight ahead, or one eye and the back of the head when he turns toward her. */
function face(ctx: Ctx, x: number, y: number, hair: string, blink: boolean, gaze: Gaze, scale: number): void {
  const stamp = (dx: number, dy: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + dx * scale, y + dy * scale, w * scale, h * scale);
  };
  const eye = blink ? PAL.skin : PAL.eye;
  if (gaze === "forward") {
    stamp(3, 5, 2, 2, eye);
    stamp(7, 5, 2, 2, eye);
    stamp(3, 7, 2, 1, PAL.coral);
    stamp(7, 7, 2, 1, PAL.coral);
    return;
  }
  const toward = gaze === "left" ? 3 : 7;
  const far = gaze === "left" ? 8 : 2;
  stamp(far, 0, 2, 8, hair);
  stamp(toward, 5, 2, 2, eye);
  stamp(toward, 7, 2, 1, PAL.coral);
}

function disc(ctx: Ctx, cx: number, cy: number, radius: number, color: string): void {
  ctx.fillStyle = color;
  for (let y = -radius; y <= radius; y++) {
    const width = Math.floor(Math.sqrt(radius * radius - y * y));
    ctx.fillRect(cx - width, cy + y, width * 2, 1);
  }
}

function blitHeart(ctx: Ctx, x: number, y: number, scale: number, color: string): void {
  ctx.fillStyle = color;
  HEART.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col++) {
      if (row[col] === "1") ctx.fillRect(x + col * scale, y + rowIndex * scale, scale, scale);
    }
  });
}

/** Title, the meadow sign, and the window that opens over the scene. */
function drawInterface(ctx: Ctx, frame: number, state: WorldState): void {
  ctx.font = FONT;
  ctx.textBaseline = "top";
  title(ctx, frame);

  if (state.screen === "world") {
    menuButton(ctx, state.board);
    timeToggle(ctx, state);
    if (state.board) sign(ctx, frame, state.selected);
    else hintFor(ctx, state);
    return;
  }

  ctx.fillStyle = "rgba(15, 10, 26, 0.62)";
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  title(ctx, frame);
}

function title(ctx: Ctx, frame: number): void {
  const lines = ["HAPPILY", "EVER CACHE"];
  ctx.save();
  ctx.textBaseline = "top";
  const room = view.right - view.left - 16;
  let size = 16;
  ctx.font = "16px 'Press Start 2P'";
  if (lines.some((line) => ctx.measureText(line).width > room)) size = 8;
  ctx.font = `${size}px 'Press Start 2P'`;
  const bob = Math.round(Math.sin(frame * 0.12));
  const y0 = Math.round(view.top + 8) + bob;
  lines.forEach((line, index) => {
    const width = ctx.measureText(line).width;
    const x = Math.round((view.left + view.right - width) / 2);
    const y = y0 + index * (size + 4);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = PAL.glow;
    ctx.fillText(line, x, y - 1);
    ctx.fillText(line, x - 1, y);
    ctx.fillText(line, x + 1, y);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAL.sunCore;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

function hintFor(ctx: Ctx, state: WorldState): void {
  const hover = state.hover;
  if (hover === "icon") {
    const icon = iconBox();
    hint(ctx, "OPEN THE STORY", icon.x + icon.w + 6, icon.y + 5);
  } else if (hover === "door") {
    hint(ctx, "CHAT", COTTAGE.x + 4, COTTAGE.roofY - 22);
  } else if (hover === "path") {
    hint(ctx, "TIMELINE", 230, GROUND_Y - 48);
  } else if (hover === "sky") {
    hintAbove(ctx, "SKY", skyButtonBox());
  } else if (state.skyOpen && hover !== null) {
    const item = timeBoxes().find((choice) => choice.id === hover);
    const name = TIMES.find((choice) => choice.id === hover)?.label;
    if (item && name) hint(ctx, name, item.box.x, item.box.y - 16);
  }
}

function hintAbove(ctx: Ctx, text: string, box: Box): void {
  ctx.font = FONT;
  ctx.textBaseline = "top";
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  hint(ctx, text, Math.round(box.x + (box.w - w) / 2), box.y - 18);
}

function hint(ctx: Ctx, text: string, x: number, y: number): void {
  ctx.font = FONT;
  ctx.textBaseline = "top";
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  panel(ctx, x, y, w, 14);
  ctx.fillStyle = PAL.apricot;
  ctx.fillText(text, x + 4, y + 3);
}

function timeToggle(ctx: Ctx, state: WorldState): void {
  const button = skyButtonBox();
  panel(ctx, button.x, button.y, button.w, button.h);
  if (state.skyOpen) {
    ctx.fillStyle = PAL.glow;
    ctx.fillRect(button.x + 2, button.y + 2, button.w - 4, button.h - 4);
  }
  const shown = state.sky === "auto" ? clockPhase : state.sky;
  blitSky(ctx, shown, button, state.skyOpen ? PAL.night : skyInk(shown));

  if (!state.skyOpen) return;
  for (const item of timeBoxes()) {
    const on = item.id === state.sky;
    panel(ctx, item.box.x, item.box.y, item.box.w, item.box.h);
    if (on) {
      ctx.fillStyle = PAL.glow;
      ctx.fillRect(item.box.x + 2, item.box.y + 2, item.box.w - 4, item.box.h - 4);
    }
    blitSky(ctx, item.id, item.box, on ? PAL.night : skyInk(item.id));
  }
}

function skyInk(id: SkyChoice): string {
  if (id === "day" || id === "dusk") return PAL.sun;
  if (id === "dawn") return PAL.peach;
  if (id === "night") return PAL.star;
  return PAL.apricot;
}

/** Clock, sunrise, sun, sunset, and a star. Each glyph is 9 pixels. */
function blitSky(ctx: Ctx, id: SkyChoice, box: Box, color: string): void {
  const glyph = SKY_GLYPH[id];
  const width = glyph[0]?.length ?? 0;
  const ox = box.x + Math.floor((box.w - width) / 2);
  const oy = box.y + Math.floor((box.h - glyph.length) / 2);
  ctx.fillStyle = color;
  glyph.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "1") ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  });
}

const SKY_GLYPH: Record<SkyChoice, readonly string[]> = {
  auto: ["0011100", "0100010", "0101010", "0111110", "0100010", "0011100"],
  dawn: ["0011100", "0100010", "0111110", "0000000", "1111111"],
  day: ["1001001", "0011100", "0111110", "1110111", "0111110", "0011100", "1001001"],
  dusk: ["1001001", "0011100", "0111110", "1111111"],
  night: ["0001000", "0011100", "0111110", "0011100", "0101010"],
};

function menuButton(ctx: Ctx, open: boolean): void {
  const icon = iconBox();
  panel(ctx, icon.x, icon.y, icon.w, icon.h);
  if (open) {
    ctx.fillStyle = PAL.glow;
    ctx.fillRect(icon.x + 2, icon.y + 2, icon.w - 4, icon.h - 4);
  }
  blitHeart(ctx, icon.x + 8, icon.y + 8, 1, open ? PAL.heart : PAL.apricot);
}

function sign(ctx: Ctx, frame: number, selected: number): void {
  const board = boardBox();
  panel(ctx, board.x, board.y, board.w, board.h);

  PLACES.forEach((place, index) => {
    const box = rowBox(index);
    const on = index === selected;
    if (on) {
      ctx.fillStyle = PAL.glow;
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    ctx.fillStyle = on ? PAL.night : PAL.apricot;
    ctx.fillText(place.label, box.x + 14, box.y + 3);
    if (on && frame % 8 < 5) blitHeart(ctx, box.x + 3, box.y + 4, 1, PAL.heart);
  });
}

function panel(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = PAL.night;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = PAL.peach;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillRect(x + w - 2, y, 2, h);
}


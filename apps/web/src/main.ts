import "@fontsource/press-start-2p";
import {
  WORLD_H,
  WORLD_W,
  hitTest,
  mountWorld,
  PLACES,
  TIMES,
  setView,
  worldPoint,
  type Screen,
  type WorldState,
} from "./scene";
import { mountPanels, syncPanel } from "./panels";
import "./style.css";

const app = document.querySelector("#app");
if (!app) throw new Error("missing #app");

app.innerHTML = `
  <main class="stage">
    <div class="monitor">
      <canvas id="world" tabindex="0" aria-label="Happily Ever Cache. The cottage door opens chat. The path opens the timeline. The heart button opens the menu. The sky button opens the time of day."></canvas>
    </div>
    <p id="status" class="sr" role="status"></p>
  </main>
`;

const stage = app.querySelector<HTMLElement>(".stage");
if (!stage) throw new Error("missing stage");
mountPanels(stage, () => back());

const canvasEl = document.querySelector<HTMLCanvasElement>("#world");
const statusEl = document.querySelector("#status");
if (!canvasEl || !statusEl) throw new Error("missing canvas");
const canvas = canvasEl;
const status = statusEl;

const state: WorldState = { screen: "world", board: false, selected: 0, hover: null, sky: "auto", skyOpen: false };
const stop = mountWorld(canvas, () => state);
fit();
canvas.focus();
announce();

window.addEventListener("resize", fit);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.screen !== "world" && document.activeElement !== canvas) back();
});

canvas.addEventListener("click", (event) => {
  const point = worldPoint(canvas, event.clientX, event.clientY);
  const hit = hitTest(point.x, point.y, state);
  if (!hit) {
    if (state.skyOpen) {
      state.skyOpen = false;
      announce();
    }
    return;
  }
  if (hit.kind === "icon") toggleBoard();
  else if (hit.kind === "sky") toggleSky();
  else if (hit.kind === "time") chooseSky(hit.id);
  else if (hit.kind === "door") open(indexOf("chat"));
  else if (hit.kind === "path") open(indexOf("timeline"));
  else if (hit.kind === "place") open(hit.index);
  else back();
});

canvas.addEventListener("mousemove", (event) => {
  const point = worldPoint(canvas, event.clientX, event.clientY);
  const hit = hitTest(point.x, point.y, state);
  canvas.style.cursor = hit ? "pointer" : "default";
  const hover = hoverOf(hit);
  if (hover !== state.hover) state.hover = hover;
});

canvas.addEventListener("keydown", (event) => {
  if (state.screen === "world") {
    if (state.board) {
      if (event.key === "ArrowDown" || event.key === "ArrowRight") move(1);
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") move(-1);
      else if (event.key === "Enter") open(state.selected);
      else if (event.key === "Escape" || event.key === "Backspace") toggleBoard();
      else return;
    } else if (state.skyOpen && (event.key === "Escape" || event.key === "Backspace")) {
      state.skyOpen = false;
      announce();
    } else if (event.key === "Enter") {
      toggleBoard();
    } else {
      return;
    }
  } else if (event.key === "Escape" || event.key === "Backspace") {
    back();
  } else {
    return;
  }
  event.preventDefault();
});

window.addEventListener("pagehide", () => {
  window.removeEventListener("resize", fit);
  stop();
});

/** Scale the world so it covers the window. The extra is cropped equally on each side. */
function fit(): void {
  const scale = Math.max(window.innerWidth / WORLD_W, window.innerHeight / WORLD_H);
  const cssW = Math.ceil(WORLD_W * scale);
  const cssH = Math.ceil(WORLD_H * scale);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  // The canvas is centred and may overhang the window. Work out which world pixels are on screen.
  const kx = cssW / WORLD_W;
  const ky = cssH / WORLD_H;
  const offsetX = (window.innerWidth - cssW) / 2;
  const offsetY = (window.innerHeight - cssH) / 2;
  setView({
    left: clamp(-offsetX / kx, 0, WORLD_W),
    right: clamp((window.innerWidth - offsetX) / kx, 0, WORLD_W),
    top: clamp(-offsetY / ky, 0, WORLD_H),
    bottom: clamp((window.innerHeight - offsetY) / ky, 0, WORLD_H),
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hoverOf(hit: ReturnType<typeof hitTest>): WorldState["hover"] {
  if (!hit) return null;
  if (hit.kind === "door" || hit.kind === "path" || hit.kind === "icon" || hit.kind === "sky") return hit.kind;
  if (hit.kind === "time") return hit.id;
  return null;
}

function chooseSky(id: WorldState["sky"]): void {
  state.sky = id;
  state.skyOpen = false;
  announce();
}

function toggleSky(): void {
  state.skyOpen = !state.skyOpen;
  if (state.skyOpen) state.board = false;
  announce();
}

function toggleBoard(): void {
  state.board = !state.board;
  if (state.board) state.skyOpen = false;
  announce();
}

function move(step: number): void {
  state.selected = (state.selected + step + PLACES.length) % PLACES.length;
  announce();
}

function indexOf(id: (typeof PLACES)[number]["id"]): number {
  return PLACES.findIndex((place) => place.id === id);
}

function open(index: number): void {
  const place = PLACES[index];
  if (!place) return;
  state.selected = index;
  state.board = false;
  state.skyOpen = false;
  state.screen = place.id;
  announce();
}

function back(): void {
  state.screen = "world" satisfies Screen;
  state.board = false;
  state.skyOpen = false;
  announce();
}

function announce(): void {
  syncPanel(state.screen);
  if (state.screen === "world") {
    if (state.skyOpen) {
      status.textContent = "Clock, dawn, day, evening, or night. Escape closes.";
      return;
    }
    if (!state.board) {
      const time = TIMES.find((item) => item.id === state.sky);
      const sky = time?.id === "auto" ? "Sky follows the clock." : `${time?.name ?? "Sky"}.`;
      status.textContent = `${sky} Door opens chat. Path opens the timeline. Heart button, enter opens the menu. Sky button changes the time of day.`;
      return;
    }
    const place = PLACES[state.selected];
    status.textContent = place ? `${place.label}. Arrows move, enter opens, escape closes.` : "";
    return;
  }
  const place = PLACES.find((item) => item.id === state.screen);
  status.textContent = place ? `${place.label}. ${place.line} Escape goes back.` : "";
}

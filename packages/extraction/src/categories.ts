import { EVENT_CATEGORIES, PASS_1_CATEGORIES, type EventCategory, type Pass1Category } from "./types";

export function isCategory(value: unknown): value is EventCategory {
  return typeof value === "string" && (EVENT_CATEGORIES as readonly string[]).includes(value);
}

export function isPass1Category(value: unknown): value is Pass1Category {
  return typeof value === "string" && (PASS_1_CATEGORIES as readonly string[]).includes(value);
}

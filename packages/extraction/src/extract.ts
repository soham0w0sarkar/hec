import { DISPLAY_TIMEZONE } from "@hec/core";
import { SarvamError, ZERO_USAGE, addUsage, type ChatModel, type Usage } from "@hec/llm";
import { windowMessage, type ExtractionPrompt } from "./prompt";
import { ExtractionOutputSchema, describeIssues, parseJsonReply, type RawEvent } from "./schema";
import { buildWindows, splitWindow, usableMessages, type TranscriptWindow, type WindowOptions } from "./transcript";
import type { Candidate, ExtractionMessage, SpeakerLabels } from "./types";
import { validateEvents, type Dropped } from "./validate";

export const DEFAULT_MAX_ATTEMPTS = 3;

export class InvalidReplyError extends Error {
  constructor(
    readonly attempts: number,
    detail: string,
  ) {
    super(`model reply was not valid after ${attempts} attempts: ${detail}`);
    this.name = "InvalidReplyError";
  }
}

export type WindowExtraction = {
  events: RawEvent[];
  usage: Usage;
  attempts: number;
};

/**
 * Asks the model about one window. A reply that is not JSON or does not match the schema is
 * retried, with the parse problems (paths and rules, never values) added to the next request.
 * Cost counts every attempt, including the ones that failed. Transport retries live in the
 * model client, not here.
 */
export async function extractWindow(
  model: ChatModel,
  prompt: ExtractionPrompt,
  window: TranscriptWindow,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<WindowExtraction> {
  const base = windowMessage(window);
  let usage = ZERO_USAGE;
  let problem = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const user =
      problem === ""
        ? base
        : `${base}\n\nYour previous reply was rejected: ${problem}\nReply again with valid JSON only.`;
    const reply = await model.complete({ system: prompt.system, user });
    usage = addUsage(usage, reply.usage);

    const json = parseJsonReply(reply.text);
    if (json === null) {
      problem = "it was not valid JSON.";
      continue;
    }
    const parsed = ExtractionOutputSchema.safeParse(json);
    if (parsed.success) return { events: parsed.data.events, usage, attempts: attempt };
    problem = describeIssues(parsed.error);
  }

  throw new InvalidReplyError(maxAttempts, problem);
}

/** A validated event and the window of its session it came from. */
export type WindowedCandidate = Candidate & { window: number };

export type SessionExtraction = {
  candidates: WindowedCandidate[];
  dropped: Dropped[];
  /** Events the model returned before validation. */
  proposed: number;
  windows: number;
  attempts: number;
  usage: Usage;
};

export type ExtractSessionOptions = WindowOptions & {
  maxAttempts?: number;
  labels: SpeakerLabels;
};

/**
 * Pass 1 for one session: shape it into windows, ask the model about each, validate in code.
 * Evidence is checked against the whole session, so a window cannot cite a message that is
 * not in the session. Windows run one after another, which keeps one job's cost predictable.
 */
export async function extractSession(
  model: ChatModel,
  prompt: ExtractionPrompt,
  messages: readonly ExtractionMessage[],
  options: ExtractSessionOptions,
): Promise<SessionExtraction> {
  const usable = usableMessages(messages);
  const windows = buildWindows(usable, options);
  const context = {
    messages: new Map(usable.map((message) => [message.id, message])),
    labels: options.labels,
    timeZone: options.timeZone ?? DISPLAY_TIMEZONE,
  };

  const result: SessionExtraction = {
    candidates: [],
    dropped: [],
    proposed: 0,
    windows: windows.length,
    attempts: 0,
    usage: ZERO_USAGE,
  };

  for (const window of windows) {
    const extractions = await extractWindowOrSplit(model, prompt, window, options);
    for (const extraction of extractions) {
      const checked = validateEvents(extraction.events, context);
      result.candidates.push(
        ...checked.candidates.map((candidate) => ({ ...candidate, window: window.index })),
      );
      result.dropped.push(...checked.dropped);
      result.proposed += extraction.events.length;
      result.attempts += extraction.attempts;
      result.usage = addUsage(result.usage, extraction.usage);
    }
  }

  return result;
}

/** True when the model's reply was cut at its output limit. Set by every provider client. */
export function isLengthCut(error: unknown): boolean {
  return error instanceof SarvamError && error.code === "length";
}

/**
 * Asks about a window. If the reply hits the output limit, the model is looping on a dense
 * stretch, so the window is split in two and each half is asked again, recursively. A window
 * of one message is not split; its cut-off error is thrown and fails the session. The cut-off
 * attempt's tokens are not counted, since the client does not return usage on error.
 */
async function extractWindowOrSplit(
  model: ChatModel,
  prompt: ExtractionPrompt,
  window: TranscriptWindow,
  options: ExtractSessionOptions,
): Promise<WindowExtraction[]> {
  try {
    return [await extractWindow(model, prompt, window, options.maxAttempts)];
  } catch (error) {
    if (!isLengthCut(error)) throw error;
    const halves = splitWindow(window, options);
    if (halves === null) throw error;
    const results: WindowExtraction[] = [];
    for (const half of halves) {
      results.push(...(await extractWindowOrSplit(model, prompt, half, options)));
    }
    return results;
  }
}

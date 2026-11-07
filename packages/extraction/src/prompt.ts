import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptWindow } from "./transcript";

export type ExtractionPrompt = {
  /** Recorded on the extraction run, for example `extract.v1`. */
  version: string;
  system: string;
};

export const CURRENT_PROMPT = "extract.v1";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../prompts");

/** Prompts live in prompts/<name>.md. A change to the wording is a new file and a new version. */
export function loadPrompt(version: string = CURRENT_PROMPT): ExtractionPrompt {
  if (!/^[a-z0-9._-]+$/i.test(version)) throw new Error(`bad prompt version "${version}"`);
  return { version, system: readFileSync(join(promptsDir, `${version}.md`), "utf8") };
}

/** The user turn for one window. Only refs and transcript lines, nothing else about the people. */
export function windowMessage(window: TranscriptWindow): string {
  const header =
    window.total > 1
      ? `Window ${window.index + 1} of ${window.total} of one session.`
      : "This is one complete session.";
  return `${header}\n\n${window.transcript}`;
}

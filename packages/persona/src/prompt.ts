import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../prompts");

/** Voice files live in prompts/. A wording change is a new file and a new version. */
export function loadPersonaPrompt(version = "persona.v1"): string {
  if (!/^[a-z0-9._-]+$/i.test(version)) throw new Error(`bad prompt version "${version}"`);
  return readFileSync(join(promptsDir, `${version}.md`), "utf8");
}

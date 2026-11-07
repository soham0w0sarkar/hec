# @hec/persona

Turns an `AnswerPayload` into the chat message. The model writes a short voice lead; dates, quotes, and message ids are appended in code. It cannot add, drop, or change a fact. It never sees tool results.

## Voices

`romance_geek` loads `prompts/persona.v1.md`. `neutral` is a plain rendering and makes no model call. A test can pass another `{ id, system }` through the same `render` function. The voice is that text, not a branch in the code.

`render(payload, persona, { model })` returns `{ text, used_message_ids, mentioned_dates }`. `facts` and `usage` come along so a caller can log tokens without logging the text.

## Checks

`validateLead` checks the model lead. `validateRender` checks the full spoken reply (lead plus receipts). Together they reject a date or number that is not in the payload, a quotation that is not a payload quote, a missing caveat, a missing date or quote or message id, a `not_found` that grows a consolation, and an `ambiguous` verdict written as if it were settled.

When `payload.sensitivity` is `heavy`, every persona is in soft mode. Jokes, innuendo, and teasing fail the check even if the quote itself contains those words. The quote is removed before that word list runs, so a real message is not punished for its own wording.

A failure is sent back once. A second failure is replaced by the neutral rendering. An unchecked persona answer is not returned.

## Tests

`bun test` uses scripted replies. It does not read export files and it does not call a tool.

`bun run evals` renders `evals/persona/payload.json` in three voices and checks that the extracted facts match, then checks that a heavy payload stays soft.

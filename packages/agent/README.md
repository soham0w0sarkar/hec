# @hec/agent

Answers a question from the tools in `@hec/retrieval` and returns a versioned `AnswerPayload`. The payload is neutral: no jokes, no emoji, no voice. `@hec/persona` is the only place that words it.

The model never receives a database handle. It sees tool results wrapped as `tool_data`, and the prompt tells it that block is data. A message that says "ignore previous instructions" is a message, not a command.

## Run

`runAgent({ question, history }, deps)` is stateless. Pass earlier turns in `history`. Chat memory stays in the API.

`deps.model` is a `ChatModel` from `@hec/llm`. The loop speaks a small JSON protocol (`action: tool` or `action: answer`) through an `ActionDecoder`. `jsonActionDecoder` is the one shipped today. A native tool-call adapter can replace it without changing the loop. Invalid JSON is retried once, then the run stops with `verdict: partial`.

`deps.embedder` is injected. It exposes `model`. `semantic_search` and `hybrid_search` return a clear error, and stay off for the rest of the run, when that name is missing or differs from `deps.chunksModel`. This package does not call an embedding provider.

Defaults: 8 model calls, 8s per tool, 80k input tokens, 8k output tokens, ₹2. Crossing the budget or the step limit returns a partial answer built only from messages already retrieved. It does not fill the gap.

## What a claim is allowed to say

After the model answers, `enforce` checks the draft against the messages, counts, and events this run actually returned.

- A message id that no tool returned is removed. A claim with none left is dropped.
- A quote that is not an exact substring of a retrieved message (or a reviewed event quote) is removed. If the claim text was that quote, the claim is dropped.
- For a first/last question, `find_first` and `find_last` also return the earliest or latest match per person and per source. Two matches from different people within an hour stay `ambiguous`, with both claims. The payload records the variants that were sent.
- Count and stats claims may only contain integers the tool returned.
- Intimate lines (and the fixture marker `SYNTHETIC_INTIMATE`) are left out of tool results and claims unless the question asked for them.
- A Conflict event, or a question about a fight, breakup, illness, or grief, sets `sensitivity` to `heavy`. A missing or unreadable sensitivity is `heavy`.

`searched` is filled from the tool calls, not from the model's draft.

## Logging

The logger receives a run id, tool name, result count, token counts, cost, and timings. It does not receive message text or the prompt.

## Tests

`bun test` in this package uses fakes. It does not open a database and it does not read export files.

`bun run evals` answers the synthetic cases in `evals/agent` against the local retrieval test database (`RETRIEVAL_TEST_DATABASE_URL`). The planner stands in for the model: it chooses a tool, then copies ids and text out of the tool result. The same payload is rendered in three voices. A conflict question stays heavy, and a planted instruction does not become the answer.

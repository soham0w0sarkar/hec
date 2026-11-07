# HEC: Happily Ever Cache

A private chatbot and timeline built on our own chat history, from Instagram and WhatsApp.

Ask it anything about us ("who said I love you first?", "when did we first call?", "what did we plan for Goa?") and it answers from the real messages, with dates and quotes as proof. It has a cheeky, romance-novel-geek personality. A second page shows our story as a timeline of milestones.

> **Privacy first:** this runs on very personal data. Raw chats and the name map live in `data/`, which is gitignored. Never commit them, never put them in a public image or volume.

---

## What it does

- **Chat page:** ask questions about our history. Every answer comes with a date and a short quote from the real conversation. If it can't find something, it says so instead of guessing.
- **Timeline page:** important moments (first chat, first call, first "I love you", trips, birthdays, big plans) in date order. Each one links back to the original conversation and shows which app it came from.
- **Stats:** streaks, busiest days, who texts first, call counts.

---

## How it works

There are two halves.

### 1. Offline pipeline (runs once, re-runnable)

```
data/raw/instagram/   -> instagram adapter -+
                                             +-> normalized messages
data/raw/whatsapp/    -> whatsapp adapter  --+
        |
        v
   source_identities (raw name -> person id)
        |
        v
   dedupe, sort by time, sanity-check dates
        |
        v
   sessionize    one timeline; a conversation can hop between apps
        |
        v
   embed         meaning-search vectors for each session
        |
        v
   extract       AI reads sessions in order and writes events, each with evidence
        |
        v
   review        I check and fix the events by hand
```

Instagram and WhatsApp each have their own parser. Both emit the same normalized message. Sessions, embeddings, search, events, and the timeline only see that shape, plus a `source` tag when they need to say which app a line came from. A later app (Telegram, for example) is one more adapter and no changes after ingest.

Each step is its own background job, so if one fails I re-run just that step.

### 2. Online app

The chat brain is an AI with tools, not a single "fetch top results" step. Questions like "who said it first" or "how many times" need searching the whole history in time order, which plain RAG can't do.

| Question type | What it uses |
| --- | --- |
| First / last / how many / when | Exact keyword search sorted by date, or the stats table |
| "What did we say about X" | Meaning search, then read the surrounding conversation |
| "What happened on this date" | Direct date lookup |

The AI can use tools several times in a row and tries different spellings and Hinglish variants ("love u", "luv u", "pyaar") on its own. When the app matters, the answer says so ("on WhatsApp, 14 Dec"). Evidence links carry the source, because "who said it first" means the earliest line across both apps.

The timeline page reads only reviewed events from the database, so it's instant and nothing is made up on the fly.

### Personality

The cheeky romance-novel-geek voice lives in its own package and only affects how answers are worded, never what gets searched. Tone can change without breaking accuracy.

---

## Stack

- **TypeScript + Node.js**
- **Turborepo** monorepo
- **Postgres + pgvector:** hosted on Supabase. Messages, sessions, events, stats, meaning search, and full-text keyword search in one database
- **Redis + BullMQ:** pipeline jobs, caching (searches and embeddings), short-term chat memory

---

## Repo layout

```
hec/
├── apps/
│   ├── api/            chat + timeline endpoints
│   ├── worker/         BullMQ workers that run the pipeline
│   └── web/            chat page + timeline page
│
├── packages/
│   ├── core/           shared types (Message, Session, Event, Chunk)
│   ├── db/             Postgres client, migrations, queries
│   ├── ingest/         one adapter per source, then one normalized stream
│   │   └── src/adapters/
│   │       ├── instagram/   message_N.json -> normalized messages
│   │       └── whatsapp/    chat .txt -> normalized messages
│   ├── sessionizer/    conversations on the merged timeline
│   ├── embeddings/     embedding provider wrapper + batching
│   ├── extraction/     AI event extraction, dedupe, evidence linking
│   ├── retrieval/      keyword search, meaning search, date lookup, stats (no AI inside)
│   ├── agent/          chat brain: tool definitions + tool-use loop
│   ├── persona/        system prompt for the voice
│   ├── queue/          Redis/BullMQ setup and job types
│   ├── llm/            LLM client wrapper (retries, caching, cost tracking)
│   └── config/         shared tsconfig, eslint, env loading
│
├── data/               contents gitignored; empty layout is kept
│   ├── raw/
│   │   ├── instagram/  message_1.json ... message_N.json
│   │   └── whatsapp/   WhatsApp chat export (.txt)
│   ├── ingest.json     raw export names -> person id, optional WhatsApp date hint
│   └── review/         events exported for manual review
│
├── evals/              known-answer questions + runner
├── docker-compose.yml  not used. Redis and Postgres are both hosted (Redis Cloud, Supabase)
├── turbo.json
└── .env.example
```

Adapters stay inside `ingest`. There is no per-app package. Adding another source is a new folder under `src/adapters/`, a value on the `message_source` enum, and an entry in `data/ingest.json`.

### Design rules

- `apps` depend on `packages`, never the other way round.
- Inside packages the flow is: `core` -> `db` / `llm` / `queue` -> pipeline packages and `retrieval` -> `agent`.
- Only an adapter knows its export format. Everything after it reads the normalized message.
- `retrieval` has no AI in it, so it can be tested directly.
- `persona` never touches search logic.

---

## Normalized message

Both adapters return the same object. `source` is a tag, not a fork. Ingest resolves `senderRaw` through `source_identities` and stores `person_id`.

| Field | Required | Meaning |
| --- | --- | --- |
| `senderRaw` | yes | the name as that export wrote it |
| `sentAt` | yes | UTC. Instagram gives UTC milliseconds. WhatsApp gives local time with no zone; read it as the display timezone (`Asia/Kolkata`), then store UTC |
| `text` | yes | message body. A WhatsApp media line with no caption stays as its short placeholder (`media omitted`) |
| `source` | yes | `instagram` or `whatsapp` |
| `sourceRef` | yes | stable id from the file and position. Instagram: `<file>:<message id>`. WhatsApp: `<file>:<first line>-<last line>` |
| `kind` | yes | `text`, `media`, `call`, `share`, `system`, or `unsent` |
| `extras` | no | reactions, shared-link info, call duration, media type. Shape differs per source |

`system` lines (encryption notices, number changes) are stored and left out of sessions, search, stats, and event extraction.

### Why WhatsApp is its own adapter

Instagram's export is JSON: one object per message, a stable id, UTC milliseconds, plus reactions and shares. The Instagram adapter also repairs the export's broken emoji and non-English encoding. None of that applies to WhatsApp.

- The export is a plain `.txt` file. A message line looks like `date, time - Name: message`.
- Continuation lines have no timestamp. They belong to the previous message.
- The date format follows the phone's region: day/month or month/day, 12-hour or 24-hour. The adapter detects which, or uses an explicit hint in `data/ingest.json` when detection is ambiguous.
- There are no reactions. Media is the text `media omitted`. Calls are short text lines and become `kind: call`.

### Identity map

`people` has two rows, one per person id (`person_1`, `person_2`). Their display names are not in the repo: `PEOPLE_DISPLAY_NAMES` in `.env` holds them as JSON, and `bun run db:migrate` writes them into `people`. `source_identities` maps each app's raw name to one person id, so the parsers never hardcode a name. The lookup is case-sensitive. Anything unmapped fails ingest.

`data/ingest.json` is how those rows get loaded:

```json
{
  "identity": {
    "instagram": {
      "<person_2's Instagram name>": "person_2",
      "<person_1's Instagram name>": "person_1"
    },
    "whatsapp": {
      "<person_2's contact name>": "person_2",
      "You": "person_1"
    }
  },
  "whatsapp": {
    "dateOrder": "DMY",
    "hourClock": "auto"
  }
}
```

The values are person ids (`person_1`, `person_2`), not display names. Leave `dateOrder` and `hourClock` out to let the adapter detect them. `hourClock` is `12`, `24`, or `auto`.

Times are stored in UTC. The display timezone lives in `app_settings` (seeded to `Asia/Kolkata`), not in this file. Calendar days, including streaks, use that zone. Changing it means refreshing `daily_stats`.

### Checks inside ingest

Each file is checked before any of its rows are written:

1. **Dedupe.** Same person, same text, from the other app, within 5 minutes: the incoming copy is skipped. Repeats inside one app are kept, because a burst of photos really is several "image omitted" lines. Files are ingested in no fixed order and stored messages are never deleted, so the copy stored first wins.
2. **Order.** In a WhatsApp file, a jump back of more than a day means the date format was read wrong. A shorter inversion is kept and printed as a warning, since the export itself sometimes writes a line out of order.
3. **Future.** No message may land after the time ingest runs. A future timestamp means the same thing.

A failed check fails that file and nothing from it is stored. A wrong day/month guess would otherwise shift the whole timeline with no error. `(source, source_ref)` is unique, so a re-run inserts nothing it already stored.

### Parallel workers

`bun run ingest` runs 4 workers by default. Change it with `INGEST_WORKERS=8 bun run ingest`, or with `--workers 8` when running the package script directly. Each worker takes the next file and handles it in one transaction:

1. Take a Postgres advisory lock on the file's source and content hash. If another worker or process holds it, move on.
2. Skip the file if `ingest_runs` already has it as succeeded.
3. Parse, check, dedupe, insert the messages, and write the `ingest_runs` row.

The lock lasts until that transaction ends, so a crash rolls back the file and releases the lock. Nothing is left half-written or stuck as running. The lock works across processes too, so starting `bun run ingest` twice is safe.

Instagram files run side by side. The WhatsApp file waits until no Instagram file is mid-insert, and Instagram files wait for it. The duplicate check only sees committed rows, so two apps inserting at once could each miss the other's copy.

---

## Database

The migration is `packages/db/migrations/0001_schema.sql`. Apply it with `bun run db:migrate`. Messages are the source of truth and are never edited or deleted. `session_id` is the exception: sessions are derived, so that column is filled in and cleared when they are rebuilt. Everything else can be dropped and built again from messages.

### `messages`

| Column | Notes |
| --- | --- |
| `person_id` | `person_1` or `person_2` |
| `sent_at` | `timestamptz`, UTC |
| `text` | |
| `source` | `instagram` or `whatsapp` |
| `source_ref` | file and position, unique together with `source` |
| `kind` | `text`, `media`, `call`, `share`, `system`, `unsent` |
| `extras` | jsonb. Empty object when the source has nothing extra |
| `session_id` | set when sessions are built |

### `sessions` and `chunks`

A session is one stretch of the merged timeline: start, end, message count, and which sources it contains. A few hours of silence starts a new one, so a conversation that moves from Instagram to WhatsApp stays one session.

`bun run sessionize` groups every message in one pass. The pass stays single-threaded, because a session boundary depends on the message before it. The writes are batched: every session row goes in with one statement, then workers set `session_id`. The default is 4 workers. Change it with `SESSION_WORKERS=8 bun run sessionize`, or with `--workers 8` when running the package script directly. Each worker takes a distinct slice of message ids and locks that slice for its transaction, so two writers never update the same rows. One more lock covers the whole rebuild. A second `sessionize` started while the first is still going stops instead of wiping the sessions the first one just wrote. A crash can leave some messages unassigned. The next run deletes every session and fills them in again.

Chunks are what gets embedded. A long session is split into size-capped pieces with a little overlap. Each chunk stores its first and last message, a transcript with timestamps and names, the embedding, and the embedding model name. The vector is 1536 dimensions so an HNSW index fits. A new model of that width is a re-embed. A different width needs a new migration.

`first_message_id` and `last_message_id` are the earliest and latest message by time. They are not an id interval. A file ingested later can give an earlier message a higher id.

### `events` and `event_evidence`

An event has a title, a one-line summary, a category, `occurred_at`, and a date precision: `exact_day`, `month`, or `approximate`. Status is `draft`, `approved`, `edited`, or `rejected`. The timeline page reads `approved` and `edited` only.

Each event points at the extraction run that created it (model and prompt version), so a re-run does not mix with the previous pass. `event_evidence` links the event to the messages that prove it, each `primary` or `supporting`. Joining that to `messages` shows which app the proof came from.

### `daily_stats` and `ingest_runs`

`daily_stats` is a materialized view: per day, per person, per source, the message count, the first message time, and the call count. System and unsent lines are excluded. Streaks and busiest days are computed from it. Refresh it after each ingest with `refresh_daily_stats()`. The day boundary follows `app_settings.display_timezone`.

`ingest_runs` is one row per file attempt (source, file hash, row counts, status), written when the attempt ends. A file that already succeeded is not inserted again; a failed one is retried on the next run.

### Indexes

- Full-text search on messages uses the `simple` config, not `english`. The English config throws away "I" and "you", which breaks "I love you". Hinglish does not stem usefully either.
- A trigram index (`pg_trgm`) on message text matches a longer word with a typo ("lovve" finds "love"). A three-letter swap such as "luv" and "love" shares too few characters and does not match.
- HNSW index, cosine distance, on chunk embeddings.
- B-tree indexes on `sent_at` and on `(person_id, sent_at)`. "First" and "last" are time-ordered scans. Calls have their own partial index.

### Keyword search

`searchMessages` in `@hec/retrieval` reads `messages` only. System and unsent lines are left out. Results are ordered by `sent_at`, so the first row is who said it first. `firstMessage` returns that row.

Several words are matched as a phrase. If the phrase never occurs, the words are matched on their own. If that misses too, the trigram comparison above runs. The first comparison with any match is the one used, and `mode` says which.

Every result set has a `total`, the number of messages that match, not only the page. Pages are 20 by default and at most 100. `next` is an opaque cursor for the following page, or null on the last page. The CLI prints the total and the command for the next page: `bun run search -- --limit 20 i love you`.

### Which table answers which question

| Question | Reads from |
| --- | --- |
| "Who said X first?" | messages (full-text or trigram, sorted by time) |
| "What did we say about Goa?" | chunks (vector), then messages for the surrounding lines |
| "When did we first call?" | messages (`kind = call`) |
| "Busiest day / streak?" | daily_stats |
| Timeline page | events + event_evidence, status approved or edited |

---

## Event extraction (`packages/extraction`)

Extraction reads each session and writes draft timeline events with links to the messages that prove them. Nothing reaches the timeline until you approve it.

**Passes.**

1. **Per session.** Each session is shaped into a transcript with a ref per message (`[m123]`), IST time, the speaker's name from `people`, and the source. Long sessions are cut into windows that overlap by 15 messages. The model returns JSON (`prompts/extract.v1.md`). A reply that is not valid JSON, or does not match the schema, is retried with the problem described. Then code checks each event: the category must be one of the nine, every evidence ref must be a message in that session, a Saying's quote must be word for word in an evidence message from the named speaker, the date must fall inside the evidence, and an end must come after the start. A Life update may be dated one day before the messages that discuss it. Failed events are dropped and counted by reason, never logged with their text.
2. **Merge.** The same event from overlapping windows, or from two neighbouring sessions, becomes one event with all its evidence.
3. **Firsts.** Every `is_first` claim is searched across the whole history with the keyword search in `@hec/retrieval`. A claim survives only if the earliest match is in its own evidence (or within a day of it). Among verified claims of the same kind, only the earliest keeps the flag.

Running jokes are not extracted yet. `running-jokes.ts` is a stub for the cross-session pass.

**Commands.** Start the worker in one terminal, then queue a run from another.

```
bun run worker                              # BullMQ worker, keep it running
bun run extract                             # new run over every session
bun run extract -- --resume <run>           # queue the unfinished sessions of an open run
bun run extract -- --resume <run> --session <id>   # re-run one session in an open run
bun run review                              # approve or reject drafts, one event at a time
bun run review -- --run <run>               # a specific run
bun run review -- --status all              # include events already decided
bun run review:export                       # writes data/review/run-<id>.md for the latest finished run
bun run review:import -- data/review/run-<id>.md --dry-run
bun run review:import -- data/review/run-<id>.md   # apply the edits
```

**Runs.** A run is one pass with one model and one prompt, recorded on `extraction_runs`. Session results are stored per run and only become events when every session is done. Finalize writes the run's events in one transaction and marks the run succeeded. A worker started with a different model or prompt refuses the run. A second `extract` makes a new run and leaves the first one's drafts alone. Old drafts are never deleted.

**Review.** `bun run review` loads a finished run and shows one event at a time, oldest first, drafts only. Two fields matter: `status` and `timeline`. `a` sets `status: approved` so chat can use the event; `t` toggles `timeline: yes`/`no`; the timeline page only shows a row when it is approved (or edited) **and** `timeline: yes`. `r` rejects it, Enter skips, `p` goes back, a number jumps to that event id, `q` quits. Each decision is saved before the next prompt. If `data/review/run-<id>.md` already exists, the same `status:` and `timeline:` lines are updated there.

The review file lists each event with its date, category, title, summary, the evidence messages, a `status:` line, and a `timeline: yes`/`no` line. Set `status:` to `approved`, `edited` or `rejected`. Change any editable line to edit the event (an approved event that you edit becomes `edited`). The evidence lines are read-only. Import refuses a malformed file outright. A bad value skips that one event and the rest still apply. Review files contain real message text, so they stay in `data/review/`, which git ignores. Editing a field is still done in the file; the terminal reviewer sets status and timeline.

**Model.** Sarvam `sarvam-105b` through `POST /v1/chat/completions`, with reasoning turned off, because thinking tokens count against the output cap. Requests are retried on network errors, 429 and 5xx, but not on 400, 401 or 402. Cost is recorded per session in rupees (`cost_inr`) from the price table in `packages/llm`. Settings come from `.env`: `SARVAM_API_KEY`, `SARVAM_MODEL`. `EXTRACTION_CONCURRENCY` (default 2) sets how many sessions run at once.

**Tests and evals.** `bun test` in `packages/extraction` covers the validators, merge, firsts, the job logic and the review import, against an in-memory store. `bun run evals` (at the root) checks ten synthetic fixtures in `evals/extraction/fixtures/`: a golden reply must pass every validator and score perfectly. `bun run evals -- --live` runs the real model on the same fixtures. The fixtures are invented and dated 2030 or later. The loader refuses any folder under `data/`.

**Open.** Approved events from an earlier run still show on the timeline next to the new run's approved events. Reject the old ones before approving a new run. The SQL store has not been run against a live database yet. Migration `0003_extraction.sql` has to be applied first with `bun run db:migrate`.

---

## Getting started (planned)

1. Export Instagram as JSON and put every `message_N.json` in `data/raw/instagram/`.
2. Export the WhatsApp chat as a `.txt` file (without media is fine) and put it in `data/raw/whatsapp/`.
3. Write `data/ingest.json` from the shape above. WhatsApp often starts earlier than the Instagram export; that is expected, and it is why event extraction waits until both are merged.
4. Copy `.env.example` to `.env` and fill in keys, including `PEOPLE_DISPLAY_NAMES`.
5. Set `DATABASE_URL` (hosted Supabase) and `REDIS_URL` (Redis Cloud, `redis://` or `rediss://`) in `.env`. Nothing runs locally.
6. Apply the schema and write the display names: `bun run db:migrate`.
7. Run the pipeline: `bun run ingest`, `bun run sessionize`, then embed and extract (see below).
8. Review the extracted events in `data/review/`, fix anything wrong.
9. Start the API and web app.

---

## Known tricky parts

- **"Who said it first" is ambiguous.** Typed it, sent a heart, or said it on a call? Decide what counts and have the bot explain its reasoning. The search itself is across both apps; the answer should name the app.
- **Timeline quality depends on event extraction**, so the manual review step is not optional.
- **Instagram encoding and WhatsApp dates are adapter problems.** Broken emoji stays inside the Instagram adapter. A wrong day/month reading stays inside the WhatsApp adapter, and the date checks above are what stop it from landing in the database.
- **WhatsApp may predate the Instagram file.** Milestones are extracted only from the merged timeline, so "first" is not whichever export you ingested last.

---

## Testing

`evals/` holds 15 to 20 questions where I already know the right answer. Run them after every change to retrieval, extraction, or the agent.

---

## Build order

1. Both adapters and keyword search on messages
2. Bare chat with tools, tested against evals
3. Sessions + meaning search
4. Event extraction + review + timeline page
5. Persona and polish

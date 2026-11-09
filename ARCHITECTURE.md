# Architecture

How HEC works under the hood: how chats become messages, how messages become events, and how the app answers questions from them. The user-facing overview and quickstart live in [README.md](README.md).

---

## System map

Two halves share one Postgres.

```
 offline (CLI / worker)                         online (browser)

 data/raw/instagram/*.json                      web (canvas world)
 data/raw/whatsapp/*.txt                              |
        |                                             v
        v                                       nginx :443  --- /api/ ---> api :3001
   ingest  (adapters, identity map, checks)            |                        |
        |                                             |                        |
        v                                             |                        v
    messages  <---------------------------------------+--------------------> postgres
        |                                                                     ^   |
        v                                                                     |   v
   sessionize  -> sessions                                                    |  redis
        |                                                                     |   ^
        v                                                                     |   |
   embed  -> chunks + vectors                                                 |   |
        |                                                                     |   |
        v                                                                     |   |
   extract (worker + Sarvam) -> events + evidence  -> review -> timeline  ----+   |
        ^                                                                         |
        +------------------------------- redis (BullMQ queue) -------------------+
```

Pipeline CLI commands and the worker are separate processes. The API is stateless apart from Postgres and Redis.

---

## 1. Offline pipeline

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
   embed         meaning-search vectors for each chunk
        |
        v
   extract       AI reads sessions in order and writes events, each with evidence
        |
        v
   review        check and fix events; pin the timeline and milestones
```

Each step is its own command (or background job), so a failed step can be re-run without replaying the rest.

| Step | Command |
| --- | --- |
| Ingest | `bun run ingest` |
| Sessions | `bun run sessionize` |
| Chunks + embeddings | `bun run embed` |
| Extraction worker | `bun run worker` (keep running) |
| Extraction run | `bun run extract` |
| Review | `bun run review` |
| Search | `bun run search -- <words>` |

---

## 2. Ingest (`packages/ingest`)

Instagram and WhatsApp each have their own parser. Both emit the same normalized message. Sessions, embeddings, search, events, and the timeline only see that shape, plus a `source` tag when they need to say which app a line came from. A later app (Telegram, for example) is one more adapter and no changes after ingest.

Adapters stay inside `ingest`. There is no per-app package.

### Normalized message

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

- The export is a plain `.txt` file. A message line looks like `date, time - Name: message`.
- Continuation lines have no timestamp and belong to the previous message.
- The date format follows the phone's region: day/month or month/day, 12-hour or 24-hour. The adapter detects which, or uses an explicit hint in `data/ingest.json` when detection is ambiguous.
- There are no reactions. Media is the text `media omitted`. Calls are short text lines and become `kind: call`.

Instagram's export is JSON: one object per message, a stable id, UTC milliseconds, reactions and shares. The Instagram adapter also repairs the export's broken emoji and non-English encoding. None of that applies to WhatsApp, so the two share a shape, not a parser.

### Identity map

`people` has two rows, one per person id (`person_1`, `person_2`). Their display names are not in the repo: `PEOPLE_DISPLAY_NAMES` in `.env` holds them as JSON, and `bun run db:migrate` writes them into `people`. `source_identities` maps each app's raw name to one person id, so the parsers never hardcode a name. The lookup is case-sensitive; anything unmapped fails ingest.

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

Values are person ids, not display names. Leave `dateOrder` and `hourClock` out to detect them. `hourClock` is `12`, `24`, or `auto`.

Times are stored in UTC. The display timezone lives in `app_settings` (seeded to `Asia/Kolkata`), not in this file. Calendar days, including streaks, use that zone. Changing it means refreshing `daily_stats`.

### Checks inside ingest

Each file is checked before any of its rows are written:

1. **Dedupe.** Same person, same text, from the other app, within 5 minutes: the incoming copy is skipped. Repeats inside one app are kept, because a burst of photos really is several "image omitted" lines. Files are ingested in no fixed order and stored messages are never deleted, so the copy stored first wins.
2. **Order.** In a WhatsApp file, a jump back of more than a day means the date format was read wrong. A shorter inversion is kept and printed as a warning.
3. **Future.** No message may land after the time ingest runs. A future timestamp means the same thing.

A failed check fails that file and nothing from it is stored. A wrong day/month guess would otherwise shift the whole timeline with no error. `(source, source_ref)` is unique, so a re-run inserts nothing it already stored.

### Parallel workers

`bun run ingest` runs 4 workers by default. Change it with `INGEST_WORKERS=8 bun run ingest`, or `--workers 8` on the package script.

1. Take a Postgres advisory lock on the file's source and content hash. If another worker or process holds it, move on.
2. Skip the file if `ingest_runs` already has it as succeeded.
3. Parse, check, dedupe, insert the messages, and write the `ingest_runs` row.

The lock lasts until that transaction ends, so a crash rolls back the file and releases the lock. Nothing is left half-written or stuck as running. Instagram files run side by side. The WhatsApp file waits until no Instagram file is mid-insert, and Instagram files wait for it, because the duplicate check only sees committed rows.

Ingest also calls `refresh_daily_stats()` when it commits.

---

## 3. Sessions and chunks (`packages/sessionizer`, `packages/embeddings`)

A session is one stretch of the merged timeline: start, end, message count, and which sources it contains. A few hours of silence starts a new one, so a conversation that moves from Instagram to WhatsApp stays one session.

`bun run sessionize` groups every message in one pass. The pass stays single-threaded, because a session boundary depends on the message before it. Writes are batched: every session row goes in with one statement, then workers set `session_id`. Default is 4 workers (`SESSION_WORKERS`, or `--workers`). Each worker takes a distinct slice of message ids and locks that slice for its transaction. One more lock covers the whole rebuild, so a second `sessionize` started while the first is going stops instead of wiping what the first just wrote. A crash can leave some messages unassigned; the next run deletes every session and fills them in again.

Chunks are what gets embedded. `bun run embed` splits a long session into size-capped pieces with a little overlap. Each chunk stores its first and last message, a transcript with timestamps and names, the embedding, and the embedding model name. The vector is 1536 dimensions so an HNSW index fits. A new model of that width is a re-embed; a different width needs a new migration. Sessions that already have chunks for that model are skipped, so the command is safe to re-run.

`first_message_id` and `last_message_id` are the earliest and latest message by time, not an id interval. A file ingested later can give an earlier message a higher id.

---

## 4. Retrieval and the agent

The chat brain is an AI with tools, not a single "fetch top results" step. Questions like "who said it first" or "how many times" need the whole history in time order, which plain RAG cannot do.

| Question type | What it uses |
| --- | --- |
| First / last / how many / when | Exact keyword search sorted by date, or the stats table |
| "What did we say about X" | Meaning search, then read the surrounding conversation |
| "What happened on this date" | Direct date lookup |

The agent can use tools several times in a row and tries spellings and Hinglish variants ("love u", "luv u", "pyaar") on its own. Evidence links carry the source, because "who said it first" means the earliest line across both apps. `retrieval` contains no AI, so it can be tested directly.

### Keyword search

`searchMessages` in `@hec/retrieval` reads `messages` only. System and unsent lines are left out. Results are ordered by `sent_at`, so the first row is who said it first. `firstMessage` returns that row.

Several words are matched as a phrase. If the phrase never occurs, the words are matched on their own. If that misses too, the trigram comparison runs. The first comparison with any match is used, and `mode` says which. Every result set has a `total` (all matching messages, not just the page). Pages are 20 by default and at most 100. `next` is an opaque cursor, or null on the last page.

### Personality

The warm, dry voice lives in `packages/persona` and only affects wording, never what gets searched. Tone can change without breaking accuracy.

### Which table answers which question

| Question | Reads from |
| --- | --- |
| "Who said X first?" | messages (full-text or trigram, sorted by time) |
| "What did we say about Goa?" | chunks (vector), then messages for the surrounding lines |
| "When did we first call?" | messages (`kind = call`) |
| "Busiest day / streak?" | daily_stats |
| Timeline page | events + event_evidence, `on_timeline = true` |

---

## 5. Event extraction (`packages/extraction`)

Extraction reads each session and writes draft timeline events with links to the messages that prove them. Nothing reaches the timeline until it is approved.

**Passes.**

1. **Per session.** Each session becomes a transcript with a ref per message (`[m123]`), IST time, the speaker's name from `people`, and the source. Long sessions are cut into windows that overlap by 15 messages. The model returns JSON (`prompts/extract.v1.md`). An invalid or schema-mismatched reply is retried with the problem described. Code then checks each event: the category must be one of the nine, every evidence ref must be a message in that session, a Saying's quote must be word for word in an evidence message from the named speaker, the date must fall inside the evidence, and an end must come after the start. A Life update may be dated one day before the messages that discuss it. Failed events are dropped and counted by reason, never logged with their text.
2. **Merge.** The same event from overlapping windows, or from two neighbouring sessions, becomes one event with all its evidence.
3. **Firsts.** Every `is_first` claim is searched across the whole history with keyword search. A claim survives only if the earliest match is in its own evidence (or within a day of it). Among verified claims of the same kind, only the earliest keeps the flag.

Running jokes are not extracted yet; `running-jokes.ts` is a stub for the cross-session pass.

**Runs.** A run is one pass with one model and one prompt, recorded on `extraction_runs`. Session results are stored per run and only become events when every session is done. Finalize writes the run's events in one transaction and marks the run succeeded. A worker started with a different model or prompt refuses the run. A second `extract` makes a new run and leaves the first one's drafts alone. Old drafts are never deleted.

```
bun run worker                                         # BullMQ worker, keep it running
bun run extract                                        # new run over every session
bun run extract -- --resume <run>                      # unfinished sessions of an open run
bun run extract -- --resume <run> --session <id>       # re-run one session
bun run review                                         # approve/reject drafts
bun run review -- --run <run>                          # a specific run
bun run review -- --status all                         # include decided events
bun run review:export                                  # data/review/run-<id>.md
bun run review:import -- data/review/run-<id>.md --dry-run
```

**Review.** `bun run review` shows one event at a time, oldest first, drafts only. Two fields matter: `status` and `timeline`. `a` approves, `t` toggles `timeline: yes`/`no`, `r` rejects, Enter skips, `p` goes back, a number jumps to that event id, `q` quits. Each decision is saved before the next prompt. The timeline page shows a row only when it is approved (or edited) **and** `timeline: yes`.

The review file lists each event with its date, category, title, summary, evidence, a `status:` line, and a `timeline:` line. Editing any editable line turns an approved event into `edited`. Evidence lines are read-only. Import refuses a malformed file outright; a bad value skips that event and the rest still apply. Review files contain real message text, so they stay in `data/review/`, which git ignores.

**Milestone pins.** `events.highlight` is a second flag, separate from `on_timeline`. The UI draws a highlighted row as a gold card with a pin. It is not part of the interactive reviewer; it is set on the row for a curated milestone (migration `0006_event_highlight.sql`).

A "first" milestone must agree with retrieval. Its `occurred_at` is the earliest **spoken** match for the phrase, and that message is the primary evidence. For said-first questions the chat uses the same rule: shares and reels are dropped (a reposted caption cannot become the first), and a phrase next to a joke marker (`majak`, `joke`, `kidding`, …) is not counted as saying it. Anniversaries sit on the date of the anniversary (the 23rd), even when the messages marking them arrived the next evening. Evidence ids come back primary-first, so the timeline's Read button opens the message the card is about. When correcting a milestone, also bump `data_version` after the update, or the timeline cache will keep the old row.

**Model.** Sarvam `sarvam-105b` through `POST /v1/chat/completions`, reasoning off, because thinking tokens count against the output cap. Requests are retried on network errors, 429, and 5xx, but not 400, 401, or 402. Cost is recorded per session in rupees (`cost_inr`) from the price table in `packages/llm`. Settings come from `.env`: `SARVAM_API_KEY`, `SARVAM_MODEL`, `EXTRACTION_CONCURRENCY` (default 2).

**Tests and evals.** `bun test` in `packages/extraction` covers validators, merge, firsts, job logic, and review import against an in-memory store. `bun run evals` checks synthetic fixtures in `evals/extraction/fixtures/`; `-- --live` runs the real model. Fixtures are dated 2030 or later and the loader refuses anything under `data/`.

---

## 6. Database (`packages/db`)

Migrations are applied in order with `bun run db:migrate`:

- `0001_schema.sql` — core tables
- `0002_people_names_from_env.sql` — display names from `.env`
- `0003_extraction.sql` — runs, events, evidence
- `0004_search_fold.sql` — normalized search text
- `0005_timeline_flag.sql` — `on_timeline`
- `0006_event_highlight.sql` — `highlight`

Messages are the source of truth and are never edited or deleted. `session_id` is the exception: sessions are derived, so that column is filled in and cleared when they are rebuilt. Everything else can be dropped and rebuilt from messages.

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

Sessions hold start/end/message count and the sources they contain. Chunks hold first/last message ids, the transcript, the vector, and the model name. Details in section 3.

### `events` and `event_evidence`

An event has a title, a one-line summary, a category, `occurred_at`, and a date precision (`exact_day`, `month`, `approximate`). Status is `draft`, `approved`, `edited`, or `rejected`. Two display flags: `on_timeline` (show on the timeline page) and `highlight` (draw as a milestone).

Each event points at the extraction run that created it (model and prompt version), so a re-run does not mix with the previous pass. `event_evidence` links the event to the messages that prove it, each `primary` or `supporting`. Joining that to `messages` shows which app the proof came from.

### `daily_stats` and `ingest_runs`

`daily_stats` is a materialized view: per day, per person, per source, the message count, first message time, and call count. System and unsent lines are excluded. Streaks and busiest days come from it. It is refreshed by `refresh_daily_stats()`, which ingest calls; `stats_version` catches up if a crash left it stale.

`ingest_runs` is one row per file attempt (source, file hash, row counts, status), written when the attempt ends. A succeeded file is not inserted again; a failed one is retried on the next run.

### Indexes

- Full-text search uses the `simple` config, not `english`: the English config throws away "I" and "you", which breaks "I love you". Hinglish does not stem usefully either.
- A trigram index (`pg_trgm`) matches a longer word with a typo ("lovve" finds "love"). A three-letter swap such as "luv" and "love" shares too few characters and does not match.
- HNSW index, cosine distance, on chunk embeddings.
- B-tree indexes on `sent_at` and `(person_id, sent_at)`. "First" and "last" are time-ordered scans. Calls have a partial index.

---

## 7. Deployment (one box)

`docker-compose.yml` runs six services:

| Service | Role | Exposure |
| --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg18` | loopback only |
| `redis` | `redis:7-alpine`, AOF on | loopback only |
| `migrate` | one-shot `packages/db/src/migrate.ts` | none |
| `api` | Bun HTTP server, port 3001 | internal only |
| `worker` | BullMQ extraction worker; mounts `./data` | none |
| `web` | nginx, static SPA + `/api/` proxy | 80/443 |

The `x-app-env` anchor rewrites `DATABASE_URL`, `REDIS_URL`, and `PG_TLS` for inside the stack. `.env` still supplies the API keys; do not point the compose stack at `127.0.0.1`, because those addresses resolve to the container itself.

Startup order is enforced by health checks: Postgres and Redis healthy → `migrate` completes → `api` healthy → `web`. `api` and `worker` restart unless stopped.

### TLS

nginx serves the ACME challenge from `./certbot/www` on port 80, redirects everything else to HTTPS, and serves the certificate from `/etc/letsencrypt` (both mounted read-only). Certbot runs on the host with the webroot challenge, and a deploy hook under `/etc/letsencrypt/renewal-hooks/deploy/` reloads the web container after a renewal.

### Operations

```sh
docker compose build
docker compose run --rm migrate       # apply schema + display names
docker compose up -d                  # start or recreate
docker compose logs -f api worker     # follow
```

Backups are the `pgdata` and `redisdata` volumes, or a logical dump:

```sh
docker compose exec -T postgres pg_dump -U hec -Fc hec > hec.dump
docker compose exec -T postgres pg_restore -U hec -d hec --clean --if-exists < hec.dump
```

After restoring older data, run `bun run db:migrate` (or the `migrate` service) so the schema matches the code, and refresh stats if the view is stale.

The app has no authentication. Keep the ports closed to the internet, or put the stack behind a VPN or an authenticating proxy.

---

## 8. Design rules

- `apps` depend on `packages`, never the other way round.
- Inside packages the flow is `core` → `db` / `llm` / `queue` → pipeline packages and `retrieval` → `agent`.
- Only an adapter knows its export format. Everything after it reads the normalized message.
- `retrieval` has no AI in it, so it can be tested directly.
- `persona` never touches search logic.
- Raw data, review files, and dumps never enter git, an image, or a shared volume.

## Known tricky parts

- **"Who said it first" is ambiguous.** Typed it, sent a heart, or said it on a call? The bot explains what it counted and names the app.
- **Timeline quality depends on extraction**, so manual review is not optional.
- **Instagram encoding and WhatsApp dates are adapter problems.** Broken emoji stays in the Instagram adapter; a wrong day/month reading is caught by ingest checks.
- **WhatsApp may predate the Instagram export.** Milestones are extracted from the merged timeline, so "first" is not whichever export was ingested last.

## Build order

1. Both adapters and keyword search on messages
2. Bare chat with tools, tested against evals
3. Sessions + meaning search
4. Event extraction + review + timeline page
5. Persona and polish

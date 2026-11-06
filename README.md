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
   identity map (export name -> person_1 | person_2)
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
- **Postgres + pgvector:** messages, sessions, events, stats, meaning search, and full-text keyword search in one database
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
│   ├── core/           shared types (Message, Session, Event). Message carries source.
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
│   ├── ingest.json     name map, timezone, optional WhatsApp date hint
│   └── review/         events exported for manual review
│
├── evals/              known-answer questions + runner
├── docker-compose.yml  postgres (pgvector) + redis
├── turbo.json
└── .env.example
```

Adapters stay inside `ingest`. There is no per-app package. Adding another source is a new folder under `src/adapters/` and an entry in `data/ingest.json`.

### Design rules

- `apps` depend on `packages`, never the other way round.
- Inside packages the flow is: `core` -> `db` / `llm` / `queue` -> pipeline packages and `retrieval` -> `agent`.
- Only an adapter knows its export format. Everything after it reads the normalized message.
- `retrieval` has no AI in it, so it can be tested directly.
- `persona` never touches search logic.

---

## Normalized message

Both adapters return the same object. `source` is a tag, not a fork.

| Field | Required | Meaning |
| --- | --- | --- |
| `who` | yes | `person_1` or `person_2`, after the identity map |
| `senderRaw` | yes | the name as that export wrote it |
| `sentAt` | yes | UTC. Instagram gives UTC milliseconds. WhatsApp gives local time with no zone; read it as `Asia/Kolkata`, then store UTC |
| `text` | yes | message body. A WhatsApp media line with no caption stays as its short placeholder (`media omitted`) |
| `source` | yes | `instagram` or `whatsapp` |
| `originalRef` | yes | pointer back into the export. The message id is `{source}:{originalRef}`, so the two apps can never collide |
| `kind` | yes | `message`, `call`, `media`, or `system` |
| `reactions` | no | Instagram only. Absent on WhatsApp |
| `share` | no | Instagram only (shared posts, reels). Absent on WhatsApp |
| `call` | no | voice or video, missed or not, when the export says so |

`kind: system` is stored and then left out of sessions, search, and event extraction. That covers lines like "messages are end-to-end encrypted" and "X changed their number".

### Why WhatsApp is its own adapter

Instagram's export is JSON: one object per message, a stable id, UTC milliseconds, plus reactions and shares. The Instagram adapter also repairs the export's broken emoji and non-English encoding. None of that applies to WhatsApp.

- The export is a plain `.txt` file. A message line looks like `date, time - Name: message`.
- Continuation lines have no timestamp. They belong to the previous message.
- The date format follows the phone's region: day/month or month/day, 12-hour or 24-hour. The adapter detects which, or uses an explicit hint in `data/ingest.json` when detection is ambiguous.
- There are no reactions. Media is the text `media omitted`. Calls are short text lines and become `kind: call`.

### Messages table

| Column | Notes |
| --- | --- |
| `id` | primary key, `{source}:{originalRef}` |
| `source` | `instagram` or `whatsapp` |
| `original_ref` | Instagram's message id, or for WhatsApp the file name plus the line range of that message |
| `sender` | `person_1` or `person_2` |
| `sender_raw` | display name from that export |
| `sent_at` | `timestamptz`, always UTC |
| `text` | |
| `kind` | `message`, `call`, `media`, or `system` |
| `reactions` | jsonb, null when the source has none |
| `share` | jsonb, null when absent |
| `call` | jsonb, null when it is not a call |

Sessions are built after the merge. A new session starts after a few hours of silence on that one timeline, so a conversation that starts on Instagram and continues on WhatsApp stays one session. Splitting by app would cut it in half.

An event's evidence is a list of message ids. The id already names the app, so one milestone can cite both sources, and "first I love you" means the earliest line in either export.

### Identity map

Names differ per app: a handle on Instagram, a contact name on WhatsApp, and sometimes `You` for your own lines. `data/ingest.json` maps each of those strings to `person_1` or `person_2`. Anything unmapped fails ingest instead of being guessed.

```json
{
  "timezone": "Asia/Kolkata",
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

Leave `dateOrder` and `hourClock` out to let the adapter detect them. Set them when you know the phone's region. `hourClock` is `12`, `24`, or `auto`.

### Checks inside ingest

After both adapters have run, ingest does three things before anything is written:

1. **Dedupe.** Same sender, same text, timestamps a few minutes apart: keep the earlier one. Overlap across two different apps is unlikely, and the check is cheap.
2. **Order.** Within each export file, timestamps must be non-decreasing. A backwards jump means the date format was read wrong.
3. **Future.** No message may land after the time ingest runs. A future timestamp means the same thing.

If any of these fail, ingest stops. A wrong day/month guess would otherwise shift the whole timeline with no error.

---

## Getting started (planned)

1. Export Instagram as JSON and put every `message_N.json` in `data/raw/instagram/`.
2. Export the WhatsApp chat as a `.txt` file (without media is fine) and put it in `data/raw/whatsapp/`.
3. Write `data/ingest.json` from the shape above. WhatsApp often starts earlier than the Instagram export; that is expected, and it is why event extraction waits until both are merged.
4. Copy `.env.example` to `.env` and fill in keys.
5. Start Postgres and Redis with Docker Compose.
6. Run the pipeline: ingest, sessionize, embed, extract.
7. Review the extracted events in `data/review/`, fix anything wrong.
8. Start the API and web app.

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

1. Both adapters, the messages table, and keyword search on the merged timeline
2. Bare chat with tools, tested against evals
3. Sessions + meaning search
4. Event extraction + review + timeline page
5. Persona and polish

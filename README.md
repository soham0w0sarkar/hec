<p align="center">
  <img src="apps/web/public/logo.svg" width="96" height="96" alt="Happily Ever Cache logo" />
</p>

# HEC: Happily Ever Cache

A private chatbot and timeline built on our own chat history, from Instagram and WhatsApp.

Ask it anything about us ("who said I love you first?", "when did we first call?", "what did we plan for Goa?") and it answers from the real messages, with dates and quotes as proof. It has a warm, dry, lightly playful voice. A second page shows our story as a timeline, with the milestones pinned.

> **Privacy first:** this runs on very personal data. Raw chats and the name map live in `data/`, which is gitignored. Never commit them, never put them in a public image or volume. The app has no login, so keep it off the open internet or put it behind a private network.

It is a two-page site:

- **Chat:** ask questions about our history. Every answer comes with a date and a short quote from the real conversation. If it can't find something, it says so instead of guessing.
- **Timeline:** important moments (first messages, first "I love you", trips, birthdays, anniversaries) in date order. Milestones get a gold card and a pin. Each one links back to the original conversation and shows which app it came from.
- **Stats:** streaks, busiest days, who texts first, call counts.

How the pipeline, retrieval, and the database work is in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Stack

- **Bun + TypeScript**, Turborepo monorepo
- **Postgres + pgvector** for messages, sessions, events, stats, meaning search, and keyword search
- **Redis + BullMQ** for pipeline jobs, caching, and short chat memory
- **Docker Compose** for the one-box deployment: Postgres, Redis, migrations, API, worker, web
- **nginx + Let's Encrypt** for TLS in front of the API and static site

## Quickstart (local)

Requirements: Bun 1.3+, and either Docker or local Postgres/Redis.

```sh
bun install
cp .env.example .env          # fill in keys, PEOPLE_DISPLAY_NAMES, DATABASE_URL, REDIS_URL
bun run db:migrate            # applies packages/db/migrations
bun run ingest                # Instagram + WhatsApp exports in data/raw
bun run sessionize            # group messages into sessions
bun run embed                 # split sessions into chunks and embed them
bun run worker                # BullMQ worker, keep it running
bun run extract               # queue event extraction over every session
bun run review                # approve drafts and toggle timeline
bun run dev                   # API + web
```

Put exports in `data/raw/instagram/*.json` and `data/raw/whatsapp/*.txt`, and write `data/ingest.json` (shape in [ARCHITECTURE.md](ARCHITECTURE.md#identity-map)). If you want Postgres and Redis on the same box, `docker compose up -d postgres redis` and use the self-hosted values from `.env.example`.

### Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | API and web in watch mode |
| `bun run build` | production build for every app |
| `bun run typecheck` | TypeScript across the workspace |
| `bun run test` | package tests |
| `bun run db:migrate` | apply migrations and write display names |
| `bun run ingest` | parse and store raw exports |
| `bun run sessionize` | group messages into sessions |
| `bun run embed` | split sessions into chunks and embed them |
| `bun run search -- i love you` | keyword search from the CLI |
| `bun run worker` | run the BullMQ worker |
| `bun run extract` | queue an extraction run |
| `bun run review` | terminal review of draft events |
| `bun run review:export` / `review:import` | review a run as Markdown |
| `bun run evals` | known-answer evals (`-- --live` for the real model) |

## Deploy (one box)

The deployment is a single `docker compose` stack. Only nginx is published; Postgres and Redis bind to loopback and the API stays on the internal network.

```sh
docker compose build
docker compose run --rm migrate     # schema + display names
docker compose up -d                # postgres, redis, api, worker, web
```

TLS is handled by certbot on the host with the webroot challenge:

```sh
sudo certbot certonly --webroot -w ./certbot/www -d <domain>
docker compose exec web nginx -s reload
```

`web` mounts `./certbot/www` read-only for challenges and `/etc/letsencrypt` read-only for the certificate. A deploy hook under `/etc/letsencrypt/renewal-hooks/deploy/` reloads the web container after a renewal. Keep the compose override of `DATABASE_URL`, `REDIS_URL`, and `PG_TLS` — inside the stack the hostnames are `postgres` and `redis`, not `127.0.0.1`.

Back up the two volumes (`pgdata`, `redisdata`) or take a logical dump:

```sh
docker compose exec -T postgres pg_dump -U hec -Fc hec > hec.dump
docker compose exec -T postgres pg_restore -U hec -d hec --clean --if-exists < hec.dump
```

## Repo layout

```
hec/
├── apps/
│   ├── api/            chat + timeline endpoints
│   ├── worker/         BullMQ workers that run the pipeline
│   └── web/            canvas world, chat page, timeline page
├── packages/
│   ├── core/           shared types (Message, Session, Event, Chunk)
│   ├── db/             Postgres client, migrations, queries
│   ├── ingest/         one adapter per source, then one normalized stream
│   ├── sessionizer/    conversations on the merged timeline
│   ├── embeddings/     embedding provider wrapper + batching
│   ├── extraction/     AI event extraction, dedupe, evidence linking
│   ├── retrieval/      keyword search, meaning search, date lookup, stats
│   ├── agent/          chat brain: tool definitions + tool-use loop
│   ├── persona/        system prompt for the voice
│   ├── queue/          Redis/BullMQ setup and job types
│   ├── llm/            LLM client wrapper (retries, caching, cost tracking)
│   └── config/         shared tsconfig, eslint, env loading
├── data/               contents gitignored; empty layout is kept
├── evals/              known-answer questions + runner
├── docker-compose.yml  one-box stack
├── ARCHITECTURE.md     pipeline, data model, retrieval, deployment internals
└── turbo.json
```

Adapters stay inside `ingest`. Adding another source is a new folder under `src/adapters/`, a value on the `message_source` enum, and an entry in `data/ingest.json`.

## Testing

`evals/` holds questions where the right answer is already known. Run them after every change to retrieval, extraction, or the agent. Extraction also has unit tests and synthetic fixtures (`evals/extraction/fixtures/`, dated 2030 or later so they cannot collide with real history).

## Known tricky parts

- **"Who said it first" is ambiguous.** Typed it, sent a heart, or said it on a call? The bot explains what it counted and names the app.
- **Timeline quality depends on event extraction**, so manual review is not optional.
- **Instagram encoding and WhatsApp dates are adapter problems.** Broken emoji stays inside the Instagram adapter; a wrong day/month reading is caught by ingest checks.
- **WhatsApp may predate the Instagram export.** "First" is computed on the merged timeline, not the last file ingested.

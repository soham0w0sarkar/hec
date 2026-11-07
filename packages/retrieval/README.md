# @hec/retrieval

Search and lookup over messages and chunks. No model calls live here. A caller that wants a vector passes the vector in.

Every message hit carries the message id, source, speaker, UTC time, a display time in `app_settings.display_timezone`, and the stored text. The text is not trimmed, rewritten, or repaired. Order for time-ordered results is `sent_at`, then `source`, then `source_ref`. The same inputs return the same rows.

`from` is inclusive. `until` is exclusive. Both are UTC instants. A calendar day is midnight to the next midnight in the display timezone, so 23:50 stays on that day.

System, unsent, and empty or whitespace-only messages are left out unless you say otherwise. Pass `kinds` to include system or unsent (the default is text, media, call, and share). Pass `includeEmpty: true` to keep blank text. No function returns an unbounded list. Limits above 100 are rejected. An empty result is a normal result. Bad input throws `RetrievalError` with `invalid_input`, a database timeout throws `timeout`, and a vector from another embedding model throws `model_mismatch`.

Nothing in this package logs message text.

## What a match is

`mode` is required. There is no silent fallback from a phrase to a typo.

| Mode | Match |
| --- | --- |
| `phrase` | The words in order, after the fold below. |
| `any_word` | Each word present, any order. |
| `fuzzy` | Word similarity of at least `TRIGRAM_WORD_SIMILARITY` (0.5) against the folded text. The compared text must be at least 3 characters. |

The fold is `search_fold` in migration `0004`, used both for the index and for the query. It strips zero-width characters, applies NFC, lowercases, and collapses a letter run of 3 or more. Both widths are stored: `two` (loveee → lovee) and `one` (loveee → love). A hit reports `form`. `two` wins when both match. A run of exactly two letters is left alone, so "lovee" does not match "love".

Emoji are tokens of their own. A variation selector is dropped, so ❤ and ❤️ match. The original text on the hit still has whatever was stored.

Fuzzy matching catches "lovve" against "love" and "i love u" against "i love you". It does not catch "luv" against "love", because those trigrams barely overlap. Pass "luv" in `variants` if the caller has that spelling. Retrieval never invents spellings. Variants are OR-ed into the same query and merged by message id.

Full text uses the `simple` config, in the index and in `search_tsquery`. User text goes in as a bound parameter through `phraseto_tsquery`, `plainto_tsquery`, or `word_similarity`. It is not concatenated into the SQL.

## Functions

Shared filters on the keyword functions, `hybridSearch`, and (except the date range) the transcript helpers: `personId`, `source`, `kinds`, `includeEmpty`, `from`, `until`.

| Function | What it returns |
| --- | --- |
| `searchMessages` | One page, plus `total` for every match and a cursor in `next`. |
| `findFirst` / `findLast` | The earliest or latest match and the next few (`runnersUp`, default 5, max 20). This is the end of a time-ordered scan, not a top-k sample. |
| `countMatches` | The count of every match. |
| `matchesPerPeriod` | Those matches grouped by display day, Monday-start week, or month. Capped at 100 periods. |
| `searchChunks` | Nearest chunks for one embedding model: chunk id, message range, transcript, time range, cosine similarity. Date, source, and person filters are inside the query, before the limit. Chunks from any other model are not compared. If every stored vector is some other model, this throws `model_mismatch`. |
| `hybridSearch` | Keyword hits and chunk hits fused with reciprocal rank fusion (`RRF_K` 60). Weights default to 1. `via` says which method found the hit. A message that falls inside a returned chunk is one hit. Each method contributes at most 100 rows. |
| `getContextAround` | The target message and up to 50 neighbours on either side, across both apps, in timeline order. The target is included even when it would normally be filtered out. A missing id returns an empty list. |
| `getDayTranscript` | One display-timezone day, paged, same caps and filters. |
| `busiestDays` | Days with the most messages, from `daily_stats`. Ties break toward the earlier day. |
| `streaks` | Longest run of consecutive days, and the run that ends on the latest day in range. |
| `whoMessagesFirst` | How many days each person sent the earliest message. A tie goes to the lower person id. |
| `callCounts` | Sum of calls and messages from `daily_stats`. |
| `countsPerPeriod` | Message and call totals per day, week, or month from `daily_stats`. |
| `encodingIssueCounts` | Counts of U+FFFD, of mojibake-shaped text, and of text that is not NFC. Counts only. |
| `readDataVersion` | The counter ingest bumps in the same transaction as an insert. |
| `memoryRetrievalCache` / `redisRetrievalCache` | Optional. The key is the data version plus a hash of the query. After a bump the old entry is never read. Pass `cache` on the call. Cache failures are ignored. The Redis value contains result text, so it belongs on your own Redis. |

`fromDay` / `untilDay` on the stats functions are `YYYY-MM-DD` in the display timezone, inclusive start, exclusive end.

Stats read `daily_stats`. If `stats_version` is behind `data_version` (an ingest committed and the process died before the refresh), the next stats call runs `refresh_daily_stats()` and then reads. A fresh view is not refreshed again.

`formatIst` and `istDayStart` are the display-time helpers. Query results take their display time from `format_display_time` in the database, which reads `app_settings`.

## Indexes and plans

Migration `0004_search_fold.sql` adds the fold columns, emoji tokens, GIN indexes on both vectors and both folded texts, a GIN index on emoji, and `messages_timeline (sent_at, source, source_ref)`. The original `text` column is unchanged. `0004_search_fold.down.sql` removes them. The migration runner ignores `*.down.sql`. This migration is not applied to the hosted database yet.

On the hosted database, before that migration, a phrase scan of the existing `simple` index was a bitmap index scan of about 2 ms, and a trigram scan was a bitmap index scan of about 190–350 ms.

On the local fixture (19 messages, 3 chunks) the planner chooses a sequential scan, which is the right plan at that size. With sequential scans turned off, the same phrase uses `Bitmap Index Scan on messages_search_vector_two`, and the nearest-chunk query uses `Index Scan using chunks_embedding_hnsw`. pgvector 0.8 also gets `hnsw.iterative_scan = strict_order` for the duration of a read, so a filter does not stop at the first handful of neighbours.

## Tests

`bun test` in this package does not open a database. `bun run test:db` runs the synthetic suite against `postgres://postgres@127.0.0.1:55432/hec_retrieval_test`. The suite calls `assertLocalTestDatabase` before connecting and will not use `DATABASE_URL`. The fixture is invented, dated 2030, and named Ravi and Anita.

Local Postgres 18 with pgvector:

```
pg_ctl -D ~/.hec/retrieval-pg -o "-p 55432 -k /tmp -c listen_addresses=127.0.0.1" -l ~/.hec/retrieval-pg.log -w start
createdb -h 127.0.0.1 -p 55432 -U postgres hec_retrieval_test
```

Apply the schema once with `DATABASE_URL` pointed at that URL, not the hosted one. `bun run evals` answers the four "who said it first" cases in `evals/retrieval` against the same fixture.

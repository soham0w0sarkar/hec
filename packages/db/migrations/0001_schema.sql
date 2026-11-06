-- HEC schema.
-- Every timestamptz is an absolute instant (UTC). The calendar day used for
-- stats comes from app_settings.display_timezone, which defaults to Asia/Kolkata.
-- Messages are the source of truth. Sessions, chunks, events, and daily_stats
-- are derived and can be rebuilt.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE TYPE message_source AS ENUM ('instagram', 'whatsapp');
CREATE TYPE message_kind AS ENUM ('text', 'media', 'call', 'share', 'system', 'unsent');
CREATE TYPE date_precision AS ENUM ('exact_day', 'month', 'approximate');
CREATE TYPE event_status AS ENUM ('draft', 'approved', 'edited', 'rejected');
CREATE TYPE evidence_role AS ENUM ('primary', 'supporting');
CREATE TYPE run_status AS ENUM ('running', 'succeeded', 'failed');

-- ---------------------------------------------------------------------------
-- App config. One row. Days in daily_stats are computed in this zone.
-- ---------------------------------------------------------------------------

CREATE TABLE app_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  display_timezone text NOT NULL DEFAULT 'Asia/Kolkata'
);

INSERT INTO app_settings (display_timezone) VALUES ('Asia/Kolkata');

CREATE FUNCTION app_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app_settings must keep its single row';
  END IF;

  IF NEW.id <> 1 THEN
    RAISE EXCEPTION 'app_settings has a single row';
  END IF;

  PERFORM 1 FROM pg_timezone_names WHERE name = NEW.display_timezone;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown timezone %', NEW.display_timezone;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER app_settings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON app_settings
  FOR EACH ROW
  EXECUTE FUNCTION app_settings_guard();

COMMENT ON TABLE app_settings IS
  'Display timezone for calendar days. Stored message times stay UTC. Refresh daily_stats after changing this.';

-- ---------------------------------------------------------------------------
-- People. Two rows, seeded with their ids. Display names are not in the repo:
-- `bun run db:migrate` writes them from PEOPLE_DISPLAY_NAMES. Parsers never
-- hardcode a raw export name; they resolve it through source_identities.
-- ---------------------------------------------------------------------------

CREATE TABLE people (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE
);

INSERT INTO people (id, name) VALUES
  ('person_1', 'person_1'),
  ('person_2', 'person_2');

CREATE TABLE source_identities (
  source message_source NOT NULL,
  raw_name text NOT NULL CHECK (length(btrim(raw_name)) > 0),
  person_id text NOT NULL REFERENCES people (id),
  PRIMARY KEY (source, raw_name)
);

COMMENT ON TABLE source_identities IS
  'Maps an export''s raw name (an Instagram handle, a WhatsApp contact name, "You") to a person. Lookup is case-sensitive.';

-- ---------------------------------------------------------------------------
-- Sessions exist before messages so messages.session_id can reference them.
-- A session is one stretch of the merged timeline and may contain both apps.
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  message_count int NOT NULL CHECK (message_count > 0),
  sources message_source[] NOT NULL CHECK (cardinality(sources) > 0),
  CHECK (ended_at >= started_at)
);

COMMENT ON TABLE sessions IS
  'A logical conversation on the merged timeline. Rebuilt from messages; extraction runs session by session.';

-- ---------------------------------------------------------------------------
-- Messages. Insert-only. session_id is the one column that changes, because
-- sessions are derived and get rebuilt.
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id text NOT NULL REFERENCES people (id),
  sent_at timestamptz NOT NULL,
  "text" text NOT NULL,
  source message_source NOT NULL,
  source_ref text NOT NULL CHECK (length(source_ref) > 0),
  kind message_kind NOT NULL,
  extras jsonb NOT NULL DEFAULT '{}',
  session_id bigint REFERENCES sessions (id) ON DELETE SET NULL,
  -- 'simple' keeps words the english config would drop ("I", "you").
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
  UNIQUE (source, source_ref)
);

COMMENT ON TABLE messages IS
  'Source of truth. Content is immutable after ingest. Re-running ingest cannot insert the same (source, source_ref) twice.';

COMMENT ON COLUMN messages.source_ref IS
  'Stable id inside one source, built from the export file and position. Instagram: "<file>:<message id>". WhatsApp: "<file>:<first line>-<last line>".';

COMMENT ON COLUMN messages.extras IS
  'Optional source-specific details: reactions, shared-link info, call duration, media type.';

COMMENT ON COLUMN messages.search_vector IS
  'Full-text vector using the simple config, not english.';

CREATE FUNCTION messages_reject_content_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'messages are immutable after ingest';
END;
$$;

CREATE TRIGGER messages_reject_content_update
  BEFORE UPDATE OF person_id, sent_at, "text", source, source_ref, kind, extras
  ON messages
  FOR EACH ROW
  EXECUTE FUNCTION messages_reject_content_update();

CREATE FUNCTION messages_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'messages are never deleted';
END;
$$;

CREATE TRIGGER messages_reject_delete
  BEFORE DELETE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION messages_reject_delete();

-- "first" / "last" are time-ordered scans.
CREATE INDEX messages_sent_at ON messages (sent_at);
CREATE INDEX messages_person_sent_at ON messages (person_id, sent_at);
CREATE INDEX messages_session_sent_at ON messages (session_id, sent_at);
CREATE INDEX messages_calls_sent_at ON messages (sent_at) WHERE kind = 'call';

-- simple config: "I love you" stays searchable. english would drop "I" and "you".
CREATE INDEX messages_search ON messages USING gin (search_vector);

-- typos and variants ("luv u", "lub u").
CREATE INDEX messages_text_trgm ON messages USING gin ("text" gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Chunks. A session can be a whole day, so meaning search embeds size-capped
-- pieces with a little overlap. first/last are the earliest and latest
-- message by sent_at, not an id interval: a later ingest can give an earlier
-- message a higher id.
-- vector(1536) fits an HNSW index (the limit is 2000). A new model of the
-- same width is a re-embed. A different width needs a migration.
-- ---------------------------------------------------------------------------

CREATE TABLE chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id bigint NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position >= 0),
  first_message_id bigint NOT NULL REFERENCES messages (id),
  last_message_id bigint NOT NULL REFERENCES messages (id),
  message_count int NOT NULL CHECK (message_count > 0),
  transcript text NOT NULL,
  embedding vector(1536),
  embedding_model text,
  UNIQUE (session_id, position),
  CHECK (
    (embedding IS NULL AND embedding_model IS NULL)
    OR (embedding IS NOT NULL AND embedding_model IS NOT NULL AND length(embedding_model) > 0)
  )
);

COMMENT ON TABLE chunks IS
  'The unit that is embedded. Transcript includes timestamps and names. Neighboring chunks may overlap.';

COMMENT ON COLUMN chunks.embedding_model IS
  'Model that produced embedding. Null until the chunk is embedded. Switching models is a re-embed of this column, not a rewrite of messages.';

CREATE FUNCTION chunks_check_range()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  first_message messages%ROWTYPE;
  last_message messages%ROWTYPE;
BEGIN
  SELECT * INTO first_message FROM messages WHERE id = NEW.first_message_id;
  SELECT * INTO last_message FROM messages WHERE id = NEW.last_message_id;

  IF first_message.session_id IS DISTINCT FROM NEW.session_id
     OR last_message.session_id IS DISTINCT FROM NEW.session_id THEN
    RAISE EXCEPTION 'chunk messages must belong to the chunk session';
  END IF;

  IF first_message.sent_at > last_message.sent_at THEN
    RAISE EXCEPTION 'chunk first message is after its last message';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER chunks_check_range
  BEFORE INSERT OR UPDATE ON chunks
  FOR EACH ROW
  EXECUTE FUNCTION chunks_check_range();

-- Cosine distance operator is <=> .
CREATE INDEX chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Extraction runs, events, evidence.
-- The timeline reads events with status approved or edited.
-- ---------------------------------------------------------------------------

CREATE TABLE extraction_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model text NOT NULL CHECK (length(model) > 0),
  prompt_version text NOT NULL CHECK (length(prompt_version) > 0),
  status run_status NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  CHECK (status <> 'succeeded' OR finished_at IS NOT NULL),
  CHECK (status <> 'failed' OR (finished_at IS NOT NULL AND error IS NOT NULL))
);

COMMENT ON TABLE extraction_runs IS
  'One row per extraction pass. Events point here so a re-run does not mix with the previous pass.';

CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  summary text NOT NULL CHECK (length(btrim(summary)) > 0),
  category text NOT NULL CHECK (length(btrim(category)) > 0),
  occurred_at timestamptz NOT NULL,
  date_precision date_precision NOT NULL,
  status event_status NOT NULL DEFAULT 'draft',
  extraction_run_id bigint NOT NULL REFERENCES extraction_runs (id)
);

COMMENT ON TABLE events IS
  'Timeline rows. date_precision is exact_day, month, or approximate. Only approved and edited rows are shown.';

COMMENT ON COLUMN events.occurred_at IS
  'UTC instant. For month or approximate precision the calendar meaning comes from date_precision, interpreted in the display timezone.';

CREATE INDEX events_timeline
  ON events (occurred_at)
  WHERE status IN ('approved', 'edited');

CREATE INDEX events_extraction_run ON events (extraction_run_id);

CREATE TABLE event_evidence (
  event_id bigint NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES messages (id),
  role evidence_role NOT NULL,
  PRIMARY KEY (event_id, message_id)
);

COMMENT ON TABLE event_evidence IS
  'Messages that prove an event. role is primary or supporting.';

CREATE INDEX event_evidence_message ON event_evidence (message_id);

-- ---------------------------------------------------------------------------
-- Ingest bookkeeping. Job progress stays in Redis, not here.
-- One successful row per (source, file hash). A failed attempt can be retried.
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source message_source NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) > 0),
  file_hash text NOT NULL CHECK (length(file_hash) > 0),
  rows_seen int CHECK (rows_seen IS NULL OR rows_seen >= 0),
  rows_inserted int CHECK (rows_inserted IS NULL OR rows_inserted >= 0),
  rows_skipped int CHECK (rows_skipped IS NULL OR rows_skipped >= 0),
  status run_status NOT NULL DEFAULT 'running',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (status <> 'succeeded' OR (
    finished_at IS NOT NULL
    AND rows_seen IS NOT NULL
    AND rows_inserted IS NOT NULL
    AND rows_skipped IS NOT NULL
  )),
  CHECK (status <> 'failed' OR (finished_at IS NOT NULL AND error IS NOT NULL))
);

CREATE UNIQUE INDEX ingest_runs_succeeded_file
  ON ingest_runs (source, file_hash)
  WHERE status = 'succeeded';

COMMENT ON TABLE ingest_runs IS
  'One row per export file processed. The unique index makes a successful re-run of the same file a no-op.';

-- ---------------------------------------------------------------------------
-- Daily stats. Streaks and busiest days are computed from this, not stored.
-- Excludes system and unsent lines. Refresh after each ingest, and after
-- changing app_settings.display_timezone.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW daily_stats AS
SELECT
  (sent_at AT TIME ZONE (SELECT display_timezone FROM app_settings))::date AS day,
  person_id,
  source,
  count(*)::int AS message_count,
  min(sent_at) AS first_message_at,
  count(*) FILTER (WHERE kind = 'call')::int AS call_count
FROM messages
WHERE kind IN ('text', 'media', 'call', 'share')
GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX daily_stats_pk ON daily_stats (day, person_id, source);

COMMENT ON MATERIALIZED VIEW daily_stats IS
  'Per day, per person, per source. day is in app_settings.display_timezone. Refresh with refresh_daily_stats().';

CREATE FUNCTION refresh_daily_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW daily_stats;
END;
$$;

-- Search normalization for retrieval.
-- messages.text is not modified. These functions and generated columns are a
-- derived index of it: zero-width characters removed, NFC, lowercase, and
-- letter runs of 3+ collapsed. Both collapse widths are stored. A query is
-- folded the same way and may match either column.
-- 'two' ranks above 'one' (a run of 3+ becomes 2, which is closer to the
-- original than collapsing it to 1).
--
-- Undo with 0004_search_fold.down.sql. The migration runner ignores *.down.sql.

CREATE FUNCTION search_fold(input text, collapse text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  stripped text;
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;
  IF collapse <> 'one' AND collapse <> 'two' THEN
    RAISE EXCEPTION 'search_fold collapse must be one or two';
  END IF;

  -- U+200B U+200C U+200D U+2060 U+FEFF. Variation selectors are not stripped
  -- here; search_emoji drops them when it builds emoji tokens.
  stripped := regexp_replace(
    input,
    '[' || chr(8203) || chr(8204) || chr(8205) || chr(8288) || chr(65279) || ']',
    '',
    'g'
  );
  stripped := lower(normalize(stripped, NFC));

  IF collapse = 'one' THEN
    RETURN regexp_replace(stripped, '([[:alpha:]])\1{2,}', '\1', 'g');
  END IF;
  RETURN regexp_replace(stripped, '([[:alpha:]])\1{2,}', '\1\1', 'g');
END;
$$;

COMMENT ON FUNCTION search_fold(text, text) IS
  'Fold text for search. collapse is two or one. Does not write messages.text.';

-- Code-point class used by search_emoji. Kept IMMUTABLE and free of tables.
CREATE FUNCTION search_cp_kind(cp integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN cp BETWEEN 127462 AND 127487 THEN 'regional'
    WHEN cp BETWEEN 127995 AND 127999 THEN 'skin'
    WHEN cp = 8205 THEN 'zwj'
    WHEN cp = 65039 OR cp = 65038 THEN 'vs'
    WHEN cp = 8419 THEN 'keycap'
    WHEN cp BETWEEN 48 AND 57 OR cp IN (35, 42) THEN 'key'
    WHEN cp BETWEEN 126976 AND 127023 THEN 'base'
    WHEN cp = 127183 THEN 'base'
    WHEN cp BETWEEN 127744 AND 129791 THEN 'base'
    WHEN cp BETWEEN 9728 AND 10175 THEN 'base'
    WHEN cp BETWEEN 11013 AND 11015 THEN 'base'
    WHEN cp BETWEEN 11035 AND 11036 THEN 'base'
    WHEN cp BETWEEN 11088 AND 11093 THEN 'base'
    WHEN cp IN (169, 174, 8252, 8265, 8482, 8505, 12336, 12349, 12951, 12953) THEN 'base'
    WHEN cp BETWEEN 8596 AND 8601 THEN 'base'
    WHEN cp BETWEEN 8617 AND 8618 THEN 'base'
    WHEN cp BETWEEN 8986 AND 9000 THEN 'base'
    WHEN cp BETWEEN 9193 AND 9210 THEN 'base'
    WHEN cp BETWEEN 9642 AND 9664 THEN 'base'
    WHEN cp BETWEEN 9723 AND 9726 THEN 'base'
    ELSE 'other'
  END;
$$;

-- One token per emoji grapheme. Variation selectors are dropped so ❤ and ❤️
-- share a token. Skin tone and ZWJ sequences stay on the token. Digits become
-- a token only as part of a keycap.
CREATE FUNCTION search_emoji(input text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  source text;
  n integer;
  i integer := 1;
  cp integer;
  kind text;
  tokens text[] := ARRAY[]::text[];
  token text;
  next_kind text;
BEGIN
  IF input IS NULL OR input = '' THEN
    RETURN ARRAY[]::text[];
  END IF;

  source := normalize(input, NFC);
  n := char_length(source);

  WHILE i <= n LOOP
    cp := ascii(substr(source, i, 1));
    kind := search_cp_kind(cp);

    IF kind = 'regional' THEN
      IF i < n AND search_cp_kind(ascii(substr(source, i + 1, 1))) = 'regional' THEN
        tokens := tokens || substr(source, i, 2);
        i := i + 2;
      ELSE
        i := i + 1;
      END IF;
      CONTINUE;
    END IF;

    IF kind = 'base'
       OR (kind = 'key' AND i < n AND search_cp_kind(ascii(substr(source, i + 1, 1))) IN ('vs', 'keycap')) THEN
      token := substr(source, i, 1);
      i := i + 1;
      LOOP
        EXIT WHEN i > n;
        next_kind := search_cp_kind(ascii(substr(source, i, 1)));
        IF next_kind = 'vs' THEN
          i := i + 1;
        ELSIF next_kind = 'skin' OR next_kind = 'keycap' THEN
          token := token || substr(source, i, 1);
          i := i + 1;
        ELSIF next_kind = 'zwj'
              AND i < n
              AND search_cp_kind(ascii(substr(source, i + 1, 1))) IN ('base', 'regional', 'key') THEN
          token := token || substr(source, i, 2);
          i := i + 2;
        ELSE
          EXIT;
        END IF;
      END LOOP;
      tokens := tokens || token;
      CONTINUE;
    END IF;

    i := i + 1;
  END LOOP;

  RETURN COALESCE(
    (SELECT array_agg(DISTINCT item ORDER BY item) FROM unnest(tokens) AS item),
    ARRAY[]::text[]
  );
END;
$$;

-- Phrases or AND-words for every text, folded, combined with OR.
-- plainto_tsquery / phraseto_tsquery parse the text, so callers never build
-- tsquery syntax themselves. Config is simple, matching messages.search_vector.
CREATE FUNCTION search_tsquery(texts text[], collapse text, mode text)
RETURNS tsquery
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  combined tsquery := NULL;
  piece tsquery;
  raw text;
BEGIN
  IF mode <> 'phrase' AND mode <> 'any_word' THEN
    RAISE EXCEPTION 'search_tsquery mode must be phrase or any_word';
  END IF;
  IF texts IS NULL THEN
    RETURN NULL;
  END IF;

  FOREACH raw IN ARRAY texts LOOP
    IF raw IS NULL OR btrim(raw) = '' THEN
      CONTINUE;
    END IF;
    IF mode = 'phrase' THEN
      piece := phraseto_tsquery('simple', search_fold(raw, collapse));
    ELSE
      piece := plainto_tsquery('simple', search_fold(raw, collapse));
    END IF;
    IF piece IS NULL OR numnode(piece) = 0 THEN
      CONTINUE;
    END IF;
    combined := CASE WHEN combined IS NULL THEN piece ELSE combined || piece END;
  END LOOP;

  RETURN combined;
END;
$$;

CREATE FUNCTION search_emoji_query(texts text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    (
      SELECT array_agg(DISTINCT token ORDER BY token)
      FROM unnest(COALESCE(texts, ARRAY[]::text[])) AS raw
      CROSS JOIN LATERAL unnest(search_emoji(COALESCE(raw, ''))) AS token
    ),
    ARRAY[]::text[]
  );
$$;

-- Display times. Reads app_settings, so STABLE rather than IMMUTABLE.
CREATE FUNCTION format_display_time(instant timestamptz)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT to_char(instant AT TIME ZONE display_timezone, 'YYYY-MM-DD HH24:MI:SS')
  FROM app_settings
  WHERE id = 1;
$$;

-- Inclusive start of a calendar day in the display timezone.
CREATE FUNCTION display_day_start(day date)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT day::timestamp AT TIME ZONE display_timezone
  FROM app_settings
  WHERE id = 1;
$$;

ALTER TABLE messages
  ADD COLUMN search_fold_two text GENERATED ALWAYS AS (search_fold("text", 'two')) STORED,
  ADD COLUMN search_fold_one text GENERATED ALWAYS AS (search_fold("text", 'one')) STORED,
  ADD COLUMN search_vector_two tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_fold("text", 'two'))) STORED,
  ADD COLUMN search_vector_one tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_fold("text", 'one'))) STORED,
  ADD COLUMN search_emoji text[] GENERATED ALWAYS AS (search_emoji("text")) STORED;

COMMENT ON COLUMN messages.search_fold_two IS
  'search_fold(text, two). messages.text itself is never rewritten.';
COMMENT ON COLUMN messages.search_fold_one IS
  'search_fold(text, one). Matched only when the two-form does not match.';
COMMENT ON COLUMN messages.search_emoji IS
  'Emoji tokens from messages.text. The original text is unchanged.';

CREATE INDEX messages_search_vector_two ON messages USING gin (search_vector_two);
CREATE INDEX messages_search_vector_one ON messages USING gin (search_vector_one);
CREATE INDEX messages_search_fold_two_trgm ON messages USING gin (search_fold_two extensions.gin_trgm_ops);
CREATE INDEX messages_search_fold_one_trgm ON messages USING gin (search_fold_one extensions.gin_trgm_ops);
CREATE INDEX messages_search_emoji ON messages USING gin (search_emoji);
-- Time order is sent_at, then source, then source_ref. Message id is not the tie-break.
CREATE INDEX messages_timeline ON messages (sent_at, source, source_ref);

-- Bumped in the same transaction as an ingest that inserts rows.
-- stats_version catches up inside refresh_daily_stats(), so a crash between
-- insert and refresh is visible and the next stats read can repair it.
ALTER TABLE app_settings
  ADD COLUMN data_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN stats_version bigint NOT NULL DEFAULT 0;

CREATE FUNCTION bump_data_version()
RETURNS bigint
LANGUAGE sql
VOLATILE
AS $$
  UPDATE app_settings
     SET data_version = data_version + 1
   WHERE id = 1
  RETURNING data_version;
$$;

CREATE OR REPLACE FUNCTION refresh_daily_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW daily_stats;
  UPDATE app_settings SET stats_version = data_version WHERE id = 1;
END;
$$;

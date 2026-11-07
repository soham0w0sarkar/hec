-- Undo 0004_search_fold.sql. Not applied by the migration runner.

DROP INDEX IF EXISTS messages_timeline;
DROP INDEX IF EXISTS messages_search_emoji;
DROP INDEX IF EXISTS messages_search_fold_one_trgm;
DROP INDEX IF EXISTS messages_search_fold_two_trgm;
DROP INDEX IF EXISTS messages_search_vector_one;
DROP INDEX IF EXISTS messages_search_vector_two;

ALTER TABLE messages
  DROP COLUMN IF EXISTS search_emoji,
  DROP COLUMN IF EXISTS search_vector_one,
  DROP COLUMN IF EXISTS search_vector_two,
  DROP COLUMN IF EXISTS search_fold_one,
  DROP COLUMN IF EXISTS search_fold_two;

CREATE OR REPLACE FUNCTION refresh_daily_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW daily_stats;
END;
$$;

ALTER TABLE app_settings
  DROP COLUMN IF EXISTS stats_version,
  DROP COLUMN IF EXISTS data_version;

DROP FUNCTION IF EXISTS bump_data_version();
DROP FUNCTION IF EXISTS display_day_start(date);
DROP FUNCTION IF EXISTS format_display_time(timestamptz);
DROP FUNCTION IF EXISTS search_emoji_query(text[]);
DROP FUNCTION IF EXISTS search_tsquery(text[], text, text);
DROP FUNCTION IF EXISTS search_emoji(text);
DROP FUNCTION IF EXISTS search_cp_kind(integer);
DROP FUNCTION IF EXISTS search_fold(text, text);

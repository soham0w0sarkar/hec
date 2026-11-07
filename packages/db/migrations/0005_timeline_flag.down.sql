-- Undo 0005_timeline_flag.sql. Not applied by the migration runner.

ALTER TABLE events DROP COLUMN IF EXISTS on_timeline;

-- 0001 pinned the display names with a CHECK on people. Names now come from
-- PEOPLE_DISPLAY_NAMES, so the database must accept any name. Idempotent: a fresh
-- database built from the current 0001 has no such constraint.
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_check;

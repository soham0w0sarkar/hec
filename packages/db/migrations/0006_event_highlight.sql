-- Highlighted milestones. Separate from on_timeline: every highlighted event is on the timeline,
-- but not every timeline event is a milestone. Set by the reviewer.
ALTER TABLE events ADD COLUMN highlight boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN events.highlight IS 'Pinned milestone: shown larger on the timeline page.';

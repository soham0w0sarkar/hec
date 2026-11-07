-- Timeline visibility, separate from review. Approved events stay available to chat; only events
-- with on_timeline = true appear on the timeline page. Off by default, so approving never adds
-- an event to the timeline by itself.
ALTER TABLE events ADD COLUMN on_timeline boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN events.on_timeline IS 'Shown on the timeline page. Set by the reviewer; chat ignores it.';

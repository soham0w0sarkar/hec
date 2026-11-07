-- Extraction. Pass 1 writes one row per (run, session) here. Events are written only when a run
-- is finalized, in one transaction after merge and first checks, so `events` never holds
-- half-merged rows and a re-run never mixes with an earlier one. Drafts are never deleted.

ALTER TABLE events
  ADD COLUMN is_first boolean NOT NULL DEFAULT false,
  ADD COLUMN first_of text,
  ADD COLUMN first_check text CHECK (first_check IN ('verified', 'refuted', 'unverified', 'superseded')),
  ADD COLUMN significance smallint NOT NULL DEFAULT 1 CHECK (significance BETWEEN 1 AND 3),
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN speaker_id text REFERENCES people (id),
  ADD COLUMN quote text,
  ADD CONSTRAINT events_category_known CHECK (category IN (
    'Milestone', 'Meetup', 'Trip', 'Celebration', 'Plan', 'Conflict', 'Running joke', 'Saying', 'Life update'
  )),
  ADD CONSTRAINT events_ended_after_start CHECK (ended_at IS NULL OR ended_at > occurred_at),
  ADD CONSTRAINT events_saying_fields CHECK (
    (category = 'Saying' AND speaker_id IS NOT NULL AND quote IS NOT NULL AND length(btrim(quote)) > 0)
    OR (category <> 'Saying' AND speaker_id IS NULL AND quote IS NULL)
  ),
  ADD CONSTRAINT events_first_is_verified CHECK (NOT is_first OR first_check = 'verified');

ALTER TABLE events ALTER COLUMN significance DROP DEFAULT;

COMMENT ON COLUMN events.is_first IS
  'Set only after the global first check (pass 3) verified it. Only the earliest event of a kind keeps it.';

COMMENT ON COLUMN events.first_of IS
  'Search words used for the first check, for example "i love you".';

COMMENT ON COLUMN events.speaker_id IS
  'Set for Saying events only: the person who sent the quoted message.';

-- How many sessions the run was started for. Finalize waits until every one has a succeeded row.
ALTER TABLE extraction_runs ADD COLUMN session_count int CHECK (session_count IS NULL OR session_count >= 0);

CREATE TABLE extraction_session_results (
  run_id bigint NOT NULL REFERENCES extraction_runs (id),
  -- No foreign key: sessionize deletes and rebuilds sessions. A stale id is caught by the job.
  session_id bigint NOT NULL,
  status run_status NOT NULL DEFAULT 'running',
  window_count int CHECK (window_count IS NULL OR window_count >= 0),
  proposed_count int CHECK (proposed_count IS NULL OR proposed_count >= 0),
  attempts int CHECK (attempts IS NULL OR attempts >= 0),
  -- Validated candidates, as written by the job (dates as ISO strings). No raw message text.
  candidates jsonb NOT NULL DEFAULT '[]',
  -- Counts by drop reason. Reasons only, never text.
  dropped jsonb NOT NULL DEFAULT '{}',
  input_tokens int CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens int CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_inr numeric(12, 4) CHECK (cost_inr IS NULL OR cost_inr >= 0),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (run_id, session_id),
  CHECK (status <> 'succeeded' OR finished_at IS NOT NULL),
  CHECK (status <> 'failed' OR (finished_at IS NOT NULL AND error IS NOT NULL))
);

COMMENT ON TABLE extraction_session_results IS
  'Pass 1 output per run and session. Re-running a session inside an open run replaces its row. Finalize reads only succeeded rows.';

COMMENT ON COLUMN extraction_session_results.cost_inr IS
  'Model cost in rupees, summed over every attempt including retries. Null when the model has no price.';

-- Finalize locks the run row, then checks that no session in it is still pending or failed.
CREATE INDEX extraction_session_results_status ON extraction_session_results (run_id, status);

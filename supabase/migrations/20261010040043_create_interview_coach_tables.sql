/*
# Voice Interview Coach schema

1. New Tables
- `sessions` — one mock interview run: role, seniority, type, optional job
  description, settings snapshot, interviewer mode, overall score and final
  feedback.
  - `id` (uuid, primary key, default gen_random_uuid())
  - `role` (text, not null)
  - `seniority` (text, not null)
  - `interview_type` (text, not null)
  - `job_description` (text, nullable)
  - `settings` (jsonb, nullable) — turn-taking settings snapshot
    (min_pause_ms, max_pause_ms, threshold, weights)
  - `interviewer_mode` (text, not null, default 'live') — 'live' | 'mock'
  - `overall_score` (numeric, nullable)
  - `feedback` (text, nullable)
  - `created_at` (timestamptz, default now())
- `turns` — one row per question or follow-up asked, with the candidate's
  transcript and everything computed about the answer.
  - `id` (uuid, primary key, default gen_random_uuid())
  - `session_id` (uuid, fk -> sessions.id, on delete cascade)
  - `idx` (int, not null) — 0-based turn index within the session
  - `kind` (text, not null) — 'question' | 'follow_up'
  - `question` (text, not null)
  - `transcript` (text, nullable) — candidate answer, text only
  - `started_at` / `ended_at` (timestamptz, nullable)
  - `end_reason` (text, nullable) — 'jev' | 'max_silence' | 'manual' | null
  - `duration_ms` (int, nullable)
  - `wpm` (numeric, nullable)
  - `filler_count` (int, nullable)
  - `star` (jsonb, nullable) — per-dimension scores, confidences, answer type
  - `composite` (numeric, nullable)
  - `jev_response` (jsonb, nullable) — raw scoring response for inspection
  - `created_at` (timestamptz, default now())
- `turn_checks` — every Jev end-of-turn check, for the live chart and the
  "interruptions avoided" metric.
  - `id` (uuid, primary key, default gen_random_uuid())
  - `turn_id` (uuid, fk -> turns.id, on delete cascade)
  - `t_ms` (int, not null) — ms since the turn started
  - `words` (int, not null) — words spoken so far
  - `finished_p` (numeric, not null)
  - `mid_sentence_p` (numeric, not null)
  - `end_prob` (numeric, not null)
  - `latency_ms` (int, not null)
  - `input_tokens` (int, nullable)
  - `cost_usd` (numeric, nullable)
  - `decision` (text, not null) — 'keep_listening' | 'end_turn' | 'stale' | 'aborted'
  - `created_at` (timestamptz, default now())

2. Security
- RLS enabled on all three tables.
- Permissive anon + authenticated policies (USING (true) / WITH CHECK (true)):
  this is a single public demo workspace with no sign-in, so all rows are
  intentionally public to the anon-key client.
- Text only is stored; no audio ever reaches the database.

3. Notes
- Indexes on (session_id), (turn_id) for the common child reads.
- Idempotent: IF NOT EXISTS on tables/indexes, DROP POLICY IF EXISTS before
  each CREATE POLICY.
*/

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL,
  seniority text NOT NULL,
  interview_type text NOT NULL,
  job_description text,
  settings jsonb,
  interviewer_mode text NOT NULL DEFAULT 'live',
  overall_score numeric,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx int NOT NULL,
  kind text NOT NULL,
  question text NOT NULL,
  transcript text,
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  duration_ms int,
  wpm numeric,
  filler_count int,
  star jsonb,
  composite numeric,
  jev_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS turn_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  t_ms int NOT NULL,
  words int NOT NULL,
  finished_p numeric NOT NULL,
  mid_sentence_p numeric NOT NULL,
  end_prob numeric NOT NULL,
  latency_ms int NOT NULL,
  input_tokens int,
  cost_usd numeric,
  decision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, idx);
CREATE INDEX IF NOT EXISTS idx_turn_checks_turn ON turn_checks(turn_id, t_ms);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_sessions" ON sessions;
CREATE POLICY "anon_read_sessions" ON sessions FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_sessions" ON sessions;
CREATE POLICY "anon_insert_sessions" ON sessions FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_sessions" ON sessions;
CREATE POLICY "anon_update_sessions" ON sessions FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_sessions" ON sessions;
CREATE POLICY "anon_delete_sessions" ON sessions FOR DELETE
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_read_turns" ON turns;
CREATE POLICY "anon_read_turns" ON turns FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_turns" ON turns;
CREATE POLICY "anon_insert_turns" ON turns FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_turns" ON turns;
CREATE POLICY "anon_update_turns" ON turns FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_turns" ON turns;
CREATE POLICY "anon_delete_turns" ON turns FOR DELETE
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_read_turn_checks" ON turn_checks;
CREATE POLICY "anon_read_turn_checks" ON turn_checks FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_turn_checks" ON turn_checks;
CREATE POLICY "anon_insert_turn_checks" ON turn_checks FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_turn_checks" ON turn_checks;
CREATE POLICY "anon_delete_turn_checks" ON turn_checks FOR DELETE
TO anon, authenticated USING (true);
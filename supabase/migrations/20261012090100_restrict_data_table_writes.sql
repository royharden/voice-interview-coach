/*
# Restrict anon writes on sessions, turns and turn_checks

1. Dropped Policies
- `anon_update_sessions`, `anon_delete_sessions`
- `anon_update_turns`, `anon_delete_turns`
- `anon_delete_turn_checks`
  The only UPDATE the app does (saving a session's overall_score and
  feedback) now runs in the `interviewer` Edge Function with the
  service-role client. The app never deletes rows.

2. Replaced Policies
- `anon_insert_sessions`, `anon_insert_turns`, `anon_insert_turn_checks`
  The browser still inserts these rows directly, so anon keeps INSERT, but
  WITH CHECK (true) is replaced by bounds on every free-form column
  (text length, jsonb size, numeric ranges, known enum values). New
  sessions must start with overall_score and feedback NULL; those are only
  written by the interviewer function.

3. Privileges
- REVOKE ALL on the three tables from anon and authenticated, then GRANT
  only SELECT and INSERT back (UPDATE, DELETE and TRUNCATE are gone at the
  privilege level too, not just via RLS).
- SELECT policies are unchanged (public demo workspace, no sign-in).

4. Notes
- Idempotent: DROP POLICY IF EXISTS before each CREATE POLICY; REVOKE/GRANT
  are safe to re-run. No data is modified.
*/

-- 1. No anon/authenticated UPDATE or DELETE.
DROP POLICY IF EXISTS "anon_update_sessions" ON public.sessions;
DROP POLICY IF EXISTS "anon_delete_sessions" ON public.sessions;
DROP POLICY IF EXISTS "anon_update_turns" ON public.turns;
DROP POLICY IF EXISTS "anon_delete_turns" ON public.turns;
DROP POLICY IF EXISTS "anon_delete_turn_checks" ON public.turn_checks;

-- 2. Bounded INSERT for the rows the browser writes.
DROP POLICY IF EXISTS "anon_insert_sessions" ON public.sessions;
CREATE POLICY "anon_insert_sessions" ON public.sessions FOR INSERT
TO anon, authenticated
WITH CHECK (
  char_length(role) <= 200
  AND char_length(seniority) <= 40
  AND char_length(interview_type) <= 40
  AND (job_description IS NULL OR char_length(job_description) <= 2000)
  AND (settings IS NULL OR octet_length(settings::text) <= 4096)
  AND interviewer_mode IN ('live', 'mock')
  AND overall_score IS NULL
  AND feedback IS NULL
);

DROP POLICY IF EXISTS "anon_insert_turns" ON public.turns;
CREATE POLICY "anon_insert_turns" ON public.turns FOR INSERT
TO anon, authenticated
WITH CHECK (
  idx BETWEEN 0 AND 200
  AND kind IN ('question', 'follow_up')
  AND char_length(question) <= 1000
  AND (transcript IS NULL OR char_length(transcript) <= 20000)
  AND (end_reason IS NULL OR end_reason IN ('jev', 'max_silence', 'manual'))
  AND (wpm IS NULL OR wpm BETWEEN 0 AND 1000000)
  AND (composite IS NULL OR composite BETWEEN 0 AND 100)
  AND (star IS NULL OR octet_length(star::text) <= 16384)
  AND (jev_response IS NULL OR octet_length(jev_response::text) <= 16384)
);

DROP POLICY IF EXISTS "anon_insert_turn_checks" ON public.turn_checks;
CREATE POLICY "anon_insert_turn_checks" ON public.turn_checks FOR INSERT
TO anon, authenticated
WITH CHECK (
  finished_p BETWEEN 0 AND 1
  AND mid_sentence_p BETWEEN 0 AND 1
  AND end_prob BETWEEN 0 AND 1
  AND (cost_usd IS NULL OR cost_usd BETWEEN 0 AND 100)
  AND decision IN ('keep_listening', 'end_turn', 'stale', 'aborted')
);

-- 3. Table privileges: SELECT and INSERT only.
REVOKE ALL ON TABLE public.sessions, public.turns, public.turn_checks FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.sessions, public.turns, public.turn_checks TO anon, authenticated;

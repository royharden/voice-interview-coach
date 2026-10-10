/*
# Add usage_counters table and increment_usage function for daily API caps

1. New Tables
- `usage_counters` — tracks how many times each edge function calls its
  backed third-party API per UTC day. Composite primary key on (day, fn).
  - `day` (date, not null) — UTC date
  - `fn` (text, not null) — function name: 'jev', 'interviewer', 'tts'
  - `calls` (int, not null, default 0) — call count for that day/function

2. New Functions
- `increment_usage(p_fn text, p_cap int) RETURNS boolean`
  - LANGUAGE sql, SECURITY INVOKER, SET search_path = public
  - Atomically inserts a new row (calls=1) or increments an existing row,
    but ONLY if the current call count is below p_cap. Returns true when
    the increment succeeded (call allowed), returns no rows (NULL) when
    the cap was already reached (call denied). This makes the cap check
    race-free: concurrent requests all hit the same atomic UPDATE.

3. Security
- RLS enabled on `usage_counters` with NO policies — the table is locked
  down for anon and authenticated roles.
- REVOKE ALL ON usage_counters FROM anon, authenticated — neither role
  can read or write the table directly.
- REVOKE EXECUTE ON increment_usage FROM PUBLIC, anon, authenticated.
- GRANT EXECUTE ON increment_usage TO service_role — only the service
  role (used by edge functions with the service role key) can call it.
- SECURITY INVOKER means the function runs with the caller's privileges,
  so only service_role can execute it.

4. Notes
- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
  DROP/REVOKE are safe to re-run.
- No existing tables or data are modified.
*/

CREATE TABLE IF NOT EXISTS usage_counters (
  day date NOT NULL,
  fn text NOT NULL,
  calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fn)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON usage_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION increment_usage(p_fn text, p_cap int)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO usage_counters (day, fn, calls)
  VALUES ((now() at time zone 'utc')::date, p_fn, 1)
  ON CONFLICT (day, fn) DO UPDATE
    SET calls = usage_counters.calls + 1
    WHERE usage_counters.calls < p_cap
  RETURNING true
$$;

REVOKE EXECUTE ON FUNCTION increment_usage(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage(text, int) TO service_role;
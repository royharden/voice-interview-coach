/*
# Make increment_usage SECURITY DEFINER

1. Changed Functions
- `increment_usage(p_fn text, p_cap int) RETURNS boolean`
  - Recreated as SECURITY DEFINER (was SECURITY INVOKER) with
    SET search_path = public, so the counter update no longer depends on the
    caller's table privileges on `usage_counters`.
  - Same atomic logic and return type: INSERT ... ON CONFLICT DO UPDATE
    increments only while calls < p_cap and RETURNING true; returns NULL once
    the cap is reached.

2. Security
- REVOKE EXECUTE FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO
  service_role. Only Edge Functions using the service-role key can count calls.
- `usage_counters` itself is unchanged: RLS on, no policies, all privileges
  revoked from anon and authenticated (see 20261010075722).

3. Notes
- Idempotent: CREATE OR REPLACE plus REVOKE/GRANT are safe to re-run.
*/

CREATE OR REPLACE FUNCTION public.increment_usage(p_fn text, p_cap int)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.usage_counters (day, fn, calls)
  VALUES ((now() at time zone 'utc')::date, p_fn, 1)
  ON CONFLICT (day, fn) DO UPDATE
    SET calls = usage_counters.calls + 1
    WHERE usage_counters.calls < p_cap
  RETURNING true
$$;

REVOKE EXECUTE ON FUNCTION public.increment_usage(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(text, int) TO service_role;

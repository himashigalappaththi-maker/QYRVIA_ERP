-- QYRVIA Phase 55 — Seed one recurring booking.hold.expire_sweep scheduled job
-- per existing tenant. The sweep runs every 5 minutes and cancels reservations
-- whose payment hold has expired without a completed payment.
--
-- WHERE NOT EXISTS makes this idempotent: replaying the migration on a live
-- database that already has sweep jobs will insert nothing.
--
-- New tenants created after this migration must have a sweep job seeded at
-- tenant-creation time (or via the /api/jobs endpoint).

BEGIN;

INSERT INTO scheduled_jobs (
  tenant_id, property_id, job_type, payload, run_at,
  recurrence_rule, timezone, next_run_at, max_attempts
)
SELECT
  t.id,
  NULL,
  'booking.hold.expire_sweep',
  '{}'::jsonb,
  now(),
  '*/5 * * * *',
  'UTC',
  now(),
  3
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM scheduled_jobs sj
  WHERE sj.tenant_id = t.id
    AND sj.job_type = 'booking.hold.expire_sweep'
);

COMMIT;

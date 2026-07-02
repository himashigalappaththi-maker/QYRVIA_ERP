# Rollback Plan

Goal: return to the last known-good release quickly and safely, without data loss.

## Triggers (roll back if any occur post-deploy)
- Readiness `GET /api/health/ready` stays `503` after startup grace period.
- Elevated error rate, auth failures, or tenant-isolation anomalies.
- A `SMOKE_TEST_CHECKLIST.md` **Section C** item fails materially.

## Pre-deploy preparation (do this every release)
- [ ] Record the currently deployed **git SHA/tag** (the rollback target).
- [ ] Confirm a **fresh DB backup** exists and restore was tested.
- [ ] Note the previous env/flag values (especially `CHANNEL_HTTP_ENABLED`,
      `AI_*`, `CHANNEL_*` flags) so they can be restored exactly.

## Application rollback (code)
1. Redeploy the previous known-good SHA/tag (blue-green or image pin per your platform).
2. Restore the previous env/flag set (no flag flips carried over).
3. Re-run health checks + `SMOKE_TEST_CHECKLIST.md` Sections A–B.

## Database considerations
- **Migrations are forward-only in this repo** (no down migrations are assumed).
  Prefer **additive, backward-compatible** schema changes so the previous app
  version runs against the new schema — this makes code rollback safe without a DB restore.
- Only restore the DB from backup if a migration is genuinely incompatible; treat a
  DB restore as a last resort with a documented data-loss window.
- Never hand-edit RLS policies during an incident; re-run `npm run db:preflight` after any DB action.

## Secrets
- If a secret was rotated as part of the bad release, restore the prior `JWT_SECRET`
  via the `JWT_SECRET` / `JWT_SECRET_PREV` window; do not print secrets in incident notes.

## After rollback
- [ ] Confirm health + smoke green on the restored version.
- [ ] File an incident note (SHA, trigger, actions, data impact) — **no secret values**.
- [ ] Add a regression test/checklist item before re-attempting the deploy.

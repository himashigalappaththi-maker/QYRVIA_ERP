# Backup and Restore Procedure

**Status:** procedure defined — **the restore drill has NOT been executed.**
Phase 63 launch gate **G9** stays PENDING until a drill is run against a
non-production database and its evidence is recorded in section 8 of this file.

`ROLLBACK_PLAN.md` names "restore the DB from backup" as the last-resort step
but never said how. This file is that missing procedure. It documents commands
only; **nothing here has been executed against any production system.**

---

## 1. What must be protected

| Asset | Where | Loss impact |
|---|---|---|
| PostgreSQL database (all tenants) | primary DB instance | Total. Reservations, folios, ledger, RLS policies, credentials table. |
| `CHANNEL_CREDENTIAL_KEY` | secret store | OTA credentials become undecryptable — a DB restore alone does not recover them. |
| `QYRVIA_NOTIFICATION_ENCRYPTION_KEY` | secret store | Encrypted notification payloads become unreadable. |
| `JWT_SECRET` / `JWT_SECRET_PREV` | secret store | All sessions invalidated on mismatch. |
| Uploaded files (`fileService` storage root) | object store / disk | Attachments lost; DB rows become dangling references. |

**Encryption keys are NOT in the database.** A database backup without the
matching key material is a partial backup. Back up and restore them together,
and record the key version alongside every dump.

---

## 2. Backup policy (target)

| Control | Target |
|---|---|
| Full logical dump | daily, retained 30 days |
| WAL / PITR archiving | continuous, retained 7 days |
| Off-instance copy | every backup, separate storage account/region |
| Encryption at rest | required (backup storage encryption) |
| Restore drill | monthly, into a scratch database, evidence recorded below |
| RPO | ≤ 5 minutes (WAL) |
| RTO | ≤ 60 minutes (full restore + preflight + smoke) |

Nothing in this repository enforces these targets. They are an infrastructure
responsibility and must be configured on the database platform.

---

## 3. Taking a backup

### 3.1 Full logical dump (custom format — required for selective restore)

```bash
pg_dump --format=custom --no-owner --no-privileges --compress=9 \
  --file "qyrvia-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$DATABASE_URL"
```

- `--no-owner --no-privileges` keeps the dump portable across role names. Roles,
  grants and RLS **policies** are re-established by the migration chain plus
  `server/scripts/db/phase62a_auth_resolvers_bootstrap.sql`, not by the dump.
- Never echo `$DATABASE_URL`. Never commit a dump into the repository.

### 3.2 Verify the dump before trusting it

```bash
pg_restore --list "qyrvia-<stamp>.dump" | head -50
```

An unreadable table of contents means the backup is worthless. Check this on
every backup, not only at restore time.

### 3.3 Schema-only snapshot (fast rollback comparison aid)

```bash
pg_dump --schema-only --no-owner --no-privileges --file "qyrvia-schema-<stamp>.sql" "$DATABASE_URL"
```

---

## 4. Restore procedure

> Restore into a **new** database first. Never restore over a live database
> that still has traffic — stop the application first and confirm zero
> connections.

1. **Freeze traffic.** Scale the application to zero / stop the service.
   Confirm `GET /health/ready` no longer answers.
2. **Capture the current state before overwriting anything** (even a corrupted
   database is evidence):
   ```bash
   pg_dump --format=custom --file "pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL"
   ```
3. **Create the restore target:**
   ```bash
   createdb qyrvia_restore
   ```
4. **Restore:**
   ```bash
   pg_restore --dbname "qyrvia_restore" --no-owner --no-privileges --jobs 4 \
     "qyrvia-<stamp>.dump"
   ```
5. **Point-in-time recovery** (only if the platform has WAL archiving): follow
   the platform's PITR flow with a target time strictly **before** the incident,
   then continue at step 6.
6. **Re-apply role and RLS bootstrap** — the dump carries no roles:
   ```bash
   psql "$RESTORE_URL" -f server/scripts/db/phase62a_auth_resolvers_bootstrap.sql
   ```
7. **Bring the schema to the deployed build's version:**
   ```bash
   cd server && DATABASE_URL="$RESTORE_URL" npm run migrate
   ```
8. **Prove tenant isolation survived the restore — mandatory, not optional:**
   ```bash
   cd server && DATABASE_URL="$RESTORE_URL" npm run db:preflight
   ```
   This must report a non-superuser, non-BYPASSRLS application role and
   `ENABLE + FORCE ROW LEVEL SECURITY` on every tenant-scoped table. **If it
   fails, the restore is not usable — stop and escalate.** A restored database
   with RLS off is a cross-tenant data breach waiting to be served.
9. **Verify the schema matches the build** (this is what the boot-time
   preflight in `server/src/db/migrationPreflight.js` enforces automatically):
   ```bash
   cd server && DATABASE_URL="$RESTORE_URL" npm run migrate:status
   ```
10. **Cut over:** repoint `DATABASE_URL` at the restored database and start the
    application. A schema mismatch now aborts boot with exit code 2 rather than
    serving traffic against a stale schema.
11. **Smoke test:**
    ```bash
    cd server && npm run smoke
    # remote target requires the explicit flag:
    # node scripts/smoke-test.js --base https://<host> --allow-remote
    ```
12. **Reconcile the channel manager.** Any OTA traffic during the lost window is
    not in the restored database. Run the reconciliation path before re-enabling
    outbound sync, and keep per-channel kill switches OFF until drift is zero.

---

## 5. Data-loss window

The window is `incident_time - last_recoverable_point`. Record it explicitly in
the incident note. It is **not** zero even with WAL archiving, and reservations
or payments taken inside the window must be reconciled by hand against:

- the payment provider's records,
- each OTA's reservation list,
- `booking_confirmation_deliveries` (what was promised to a guest).

A guest holding a confirmation for a reservation that no longer exists is the
worst outcome of a restore. Reconcile confirmations before reopening bookings.

---

## 6. What a restore does NOT recover

- Secrets and encryption keys (separate store — see section 1).
- Uploaded files, unless the object store is restored to the same point.
- In-flight outbound channel queue work that had already been dispatched.
- Anything written after the backup/PITR target.

---

## 7. Drill checklist (run monthly; this is gate G9)

- [ ] Restore the latest dump into a scratch database.
- [ ] `npm run migrate` completes with no pending versions.
- [ ] `npm run db:preflight` passes (RLS FORCE + non-superuser role).
- [ ] Row counts for `tenants`, `properties`, `reservations`, `ledger_entries`
      match the source within the expected window.
- [ ] `npm run smoke` passes against an app pointed at the restored database.
- [ ] Elapsed wall-clock time recorded and compared against the 60-minute RTO.
- [ ] Scratch database dropped afterwards.

## 8. Drill evidence log

| Date (UTC) | Operator | Backup stamp | RTO actual | RLS preflight | Smoke | Notes |
|---|---|---|---|---|---|---|
| _(none yet)_ | | | | | | **G9 remains PENDING until a row exists here.** |

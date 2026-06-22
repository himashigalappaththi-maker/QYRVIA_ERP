# Password / User Migration: `gk_users` localStorage → backend

Status: **Phase 2 deliverable — migration tool ships; frontend stays on
localStorage until a later phase explicitly switches the login form over.**

## Why this exists

Phase 1 of the strip pass confirmed that the frontend has been storing user
records in `localStorage["gk_users"]` with **plaintext passwords**. Phase 2
introduces backend-managed users (`users`, `user_roles`, `roles`, bcrypt
hashing). This document is the bridge.

## Source state (frontend)

```js
// localStorage["gk_users"]
[
  {
    id:         "abc123",
    name:       "Jane Doe",
    username:   "jane.doe",
    password:   "PlaintextSecret",        // <-- plaintext, must be migrated
    role:       "corporate_admin",         // <-- legacy role string
    department: "Front Office",
    createdAt:  "2026-01-15T10:00:00Z"
  },
  ...
]
```

## Target state (backend)

For each input record:

1. One row in `users` with bcrypt-hashed password, scoped to one `tenants.id`,
   `status = 'ACTIVE'`.
2. One row in `user_roles` linking to the seeded `roles.id` whose `code`
   matches the legacy role string (see mapping table below).
3. One audit row in `audit_events` of type `user.migrated_from_localstorage`.

## Migration procedure (one-shot, per browser)

This is a **human-supervised** operation. Run it on an operator workstation
with access to both the running backend and the browser that holds the
localStorage data.

### Step 1 — export the localStorage records

In the browser DevTools console of an authenticated session:

```js
copy(localStorage.getItem('gk_users'));
```

Paste into a file, e.g. `gk_users_export.json`.

### Step 2 — run the migration tool (server-side)

```bash
cd server
node src/scripts/migrate-gk-users.js \
  --tenant-code <code> \
  --input ./gk_users_export.json
```

Add `--dry-run` first to preview without writing.

Output:

```
---
tenant: HOTEL-A
input records: 12
created: 11
skipped (already present): 1
failed: 0
```

The tool is idempotent — re-running it skips already-migrated users.

### Step 3 — verify

```bash
psql $DATABASE_URL -c \
  "SELECT u.username, r.code AS role
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
    WHERE u.tenant_id = (SELECT id FROM tenants WHERE code = '<code>')
    ORDER BY u.username;"
```

### Step 4 — try a login through the backend

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"tenant_code":"<code>","username":"jane.doe","password":"PlaintextSecret"}'
```

Expect a 200 response with `access_token` + `refresh_token` + `user` + roles
+ permissions.

### Step 5 — clear browser localStorage

Per browser:

```js
localStorage.removeItem('gk_users');
localStorage.removeItem('gk_current_user');   // if it exists
```

## Legacy role → seeded role mapping

| Legacy `role` (lowercased)     | Mapped backend `roles.code` |
|---|---|
| `super_admin`, `superadmin`    | `super_admin`               |
| `admin`, `gm`, `general_manager`, `director` | `corporate_admin` |
| `property_admin`               | `property_admin`            |
| `finance_manager`              | `finance_manager`           |
| `front_desk_manager`, `front_office_manager`, `revenue_manager` | `front_office_manager` |
| `hr_manager`, `hr_officer`     | `hr_manager`                |
| `hod`, `department_head`       | `department_head`           |
| `inventory_manager`, `storekeeper`, `procurement` | `inventory_manager` |
| `reception`, `front_desk`, `housekeeping`, `sales_manager`, `staff` | `staff` |
| Anything else                   | `staff` (defensive default) |

## Rollback

The localStorage records are not modified by the tool. To roll back:

```sql
-- soft-delete migrated users (does NOT delete; preserves audit references)
UPDATE users
   SET soft_deleted_at = now()
 WHERE tenant_id = (SELECT id FROM tenants WHERE code = '<code>')
   AND created_at >= '<migration-timestamp>';
```

The frontend continues to authenticate against `localStorage["gk_users"]`
until a later phase swaps the login form over to call `/api/auth/login`.

## When the frontend cuts over (NOT Phase 2)

A later phase will:

1. Replace the localStorage check in `QYRVIA_ERP_V35-1.html`'s `doLogin()`
   function with a `fetch('/api/auth/login', …)` call.
2. Store the access + refresh tokens in `sessionStorage` (NOT localStorage —
   tokens should not survive a tab close).
3. Add an Authorization header (`Bearer <access_token>`) to every existing
   `fetch('/api/…')` call in the file.
4. Wire `/api/auth/refresh` into the existing keepalive timer.
5. Delete the `loadUsers()` / `saveUsers()` helpers and the User Manager
   page's localStorage write path.

Phase 2 ships none of that. Frontend HTML stays untouched.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Plaintext passwords live on the operator's disk between export and migration | Run the tool, then `shred` / delete the JSON file. Document this in the runbook. |
| Two browsers hold the same `gk_users` snapshot; second migration is a no-op | Idempotency relies on `(tenant_id, username)` UNIQUE constraint — duplicates are skipped, not failed. |
| Legacy role string not in the mapping table | Defaults to `staff`. Output log warns; operator can re-grant manually via a future role-grant command. |
| Frontend continues to authenticate against `gk_users` after backend users exist | Acceptable for Phase 2. Cutover happens in a later, dedicated phase to keep change surfaces tight. |

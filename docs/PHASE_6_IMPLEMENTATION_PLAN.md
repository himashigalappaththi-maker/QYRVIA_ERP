# QYRVIA Phase 6 — Implementation Plan

> Approved scope: close Critical Gaps **C14, C2, C1, C3, C4, C13** plus Step-5
> hardening. Five steps, ~9 focused days, six additive migrations
> (`0031`–`0036`), no destructive changes. Binding constraints: ten
> conditions from the Phase 6 approval letter (no regressions, BC,
> immutable Property ID, audit + business-date awareness, Settings Center
> sole source, CQRS+EDA+RBAC, no fake AI).
>
> **Step boundary:** when step N finishes, **all 259+ existing tests still
> pass** AND the step's own new tests pass before step N+1 begins.

---

## Step 1 — Settings Catalog & Validator (C14)

### Deliverables
- Migration `0034_settings_catalog.sql`.
- Extension of `settingsService` with `register(category, key, spec)` + validating `set()`.
- A boot-time catalog registration that declares the known settings keys.
- Tests covering accept / reject / unknown-category-passthrough.

### Schemas
```sql
CREATE TABLE settings_schema (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  category            VARCHAR(40)  NOT NULL,
  key                 VARCHAR(80)  NOT NULL,
  value_type          VARCHAR(20)  NOT NULL CHECK (value_type IN
                        ('boolean','int','number','string','json','enum','duration_seconds')),
  default_value_json  JSONB,
  enum_values         TEXT[],
  description         TEXT,
  requires_permission VARCHAR(80),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (category, key)
);
```

### Aggregates
- `settings_schema_entry` (registry-only; no event sourcing).

### Events
- `settings.schema.registered` — emitted at boot when a key is added.
- `settings.set.rejected` — emitted when a `set` call fails validation.
- (Existing `settings.updated` / `settings.deleted` unchanged.)

### APIs
- `GET /api/settings/schema` — list (filterable by category).
- `GET /api/settings/schema/:category/:key` — single entry.
- No write API — catalog is registered in code, not via REST.

### Permissions
- `settings.schema.read` — view registry. Auto-granted to roles holding `settings.read`.

### Settings
- N/A (this *is* the settings substrate).

### Migration Impact
- New table only. Idempotent reads via `(category, key)` UNIQUE.
- `settings.upsertSetting` paths unchanged at SQL level. Validation lives in the service.

### Test Coverage Requirements
- `settings.set` with a registered key + valid type → accepts.
- `settings.set` with a registered key + wrong type → rejects with `setting_invalid_type`.
- `settings.set` with a registered enum key + invalid value → rejects with `setting_invalid_enum`.
- `settings.set` with an UNREGISTERED key → still accepts (backward compatible; emits a `settings.unregistered_key` warn-event so we can find gaps).
- `settings.schema.list` returns only entries for the requested category.

### Acceptance Criteria
- All Phase 5.5 settings-related tests still pass.
- New test file `test/settingsCatalog.test.js` adds ≥6 tests, all green.
- No public REST endpoint accepts schema mutations.

---

## Step 2 — Auth Multi-Property (C2, C1, C3)

### Deliverables
- Migration `0031_auth_property_login.sql` (helper indexes).
- `identityRepo.listAccessibleProperties(userId)` + `findUserByPropertyCodeUsername(propertyCode, username)`.
- `tokensService.issueAccessToken` accepts an explicit `primaryPropertyId`.
- New routes: `POST /api/auth/properties`, `POST /api/auth/switch-property`.
- Login route accepts EITHER `tenant_code` OR `property_code` (mutually exclusive). 100 % backward compatible.
- Tests for: listing access, switching with re-validation, login by property_code, denying switch to a property the user has no role at.

### Schemas
```sql
-- Speed up the (property_code, username) lookup.
CREATE INDEX IF NOT EXISTS idx_user_roles_user_property
  ON user_roles(user_id, property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_properties_code_tenant
  ON properties(code, tenant_id);
```
No table additions or column drops.

### Aggregates
- None (auth flows on `user_roles`, `properties`, `refresh_tokens`).

### Events
- `user.property_listed` (audited query).
- `user.property_switched` — payload `{from_property_id, to_property_id}`.
- (Existing `user.logged_in` payload extended with `login_via: 'property_code'|'tenant_code'`.)

### APIs
- `GET  /api/auth/properties` (auth required) → `[{property_id, code, name, role_codes_at_property}]` for the calling user.
- `POST /api/auth/switch-property { property_id }` (auth required) → new `{access_token, refresh_token}` scoped to the target. Re-checks `user_roles` server-side; refuses if no role at target.
- `POST /api/auth/login` body now accepts `{property_code|tenant_code, username, password}`. Exactly one identifier must be present.

### Permissions
- No new permission codes. Re-uses existing `user_roles` to gate the switch.

### Settings
- `multi_property.switcher_remember_choice` (boolean, default `true`). Registered in the catalog (Step 1).

### Migration Impact
- Index-only migration; safe to apply with active connections.
- JWT shape gains `accessible_property_ids: UUID[]` (optional). Old tokens without the field continue to work — the switcher endpoint will do a fresh DB read for them.

### Test Coverage Requirements
- `listAccessibleProperties` returns distinct property_ids from `user_roles`.
- `switch-property` to a permitted property issues a new JWT with the new `primary_property_id` and rotates the refresh token.
- `switch-property` to a forbidden property returns 403 `not_authorized_at_property` and is audited.
- Login by `property_code + username + password` succeeds and tokens carry `login_via='property_code'`.
- Login with BOTH `property_code` and `tenant_code` is rejected `invalid_login_identifiers`.
- Existing login-by-tenant-code tests still pass (BC contract).

### Acceptance Criteria
- 259 existing tests still pass.
- New tests in `test/auth_multiproperty.test.js` (≥8) all pass.
- Audit pipeline emits `user.property_switched` on every successful switch.

---

## Step 3 — Meal Policy Engine (C4)

### Deliverables
- Migration `0032_meal_plans.sql`.
- Repo extension `pmsRepo.insertMealPlan / findMealPlanById / listMealPlans / linkRatePlanMealPlan`.
- Commands `pms.mealplan.create`, `pms.mealplan.attach_to_rateplan`.
- Queries `pms.mealplan.list`, `pms.mealplan.byId`.
- Routes under `/api/pms/meal-plans`.
- Tests covering creation, linking to rate plan, occupancy + meal-charge interplay.

### Schemas
```sql
CREATE TYPE meal_plan_basis AS ENUM ('RO','BB','HB','FB','AI','CUSTOM');

CREATE TABLE meal_plans (
  id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID            NOT NULL REFERENCES tenants(id),
  property_id        UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code               VARCHAR(20)     NOT NULL,
  name               VARCHAR(200)    NOT NULL,
  basis              meal_plan_basis NOT NULL,
  includes_breakfast BOOLEAN         NOT NULL DEFAULT false,
  includes_lunch     BOOLEAN         NOT NULL DEFAULT false,
  includes_dinner    BOOLEAN         NOT NULL DEFAULT false,
  includes_snack     BOOLEAN         NOT NULL DEFAULT false,
  adult_rate         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  child_rate         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  active             BOOLEAN         NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  created_by         UUID,
  UNIQUE (property_id, code)
);

ALTER TABLE rate_plans
  ADD COLUMN IF NOT EXISTS meal_plan_id UUID REFERENCES meal_plans(id) ON DELETE SET NULL;

-- RLS
ALTER TABLE meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_plans FORCE  ROW LEVEL SECURITY;
CREATE POLICY meal_plans_by_app ON meal_plans
  USING (tenant_id::text = current_setting('app.tenant_id', true));
```

### Aggregates
- `meal_plan`.

### Events
- `meal_plan.created` — payload `{code, basis, includes_*}`.
- `meal_plan.updated`.
- `rate_plan.meal_plan_linked` — payload `{rate_plan_id, meal_plan_id}`.

### APIs
- `GET  /api/pms/meal-plans` — list.
- `GET  /api/pms/meal-plans/:id` — single.
- `POST /api/pms/meal-plans` — create.
- `POST /api/pms/rate-plans/:id/meal-plan` — attach `{meal_plan_id}`.

### Permissions
- `pms.mealplan.read` — read.
- `pms.mealplan.write` — create / attach.
- Granted to `corporate_admin`, `property_admin`, `front_office_manager`.

### Settings
- `pms.default_meal_plan_id` (UUID, nullable) per-property.

### Migration Impact
- New table + nullable FK on `rate_plans`. No backfill required.

### Test Coverage Requirements
- Create a meal plan (BB basis, includes_breakfast=true).
- Reject duplicate `(property_id, code)`.
- Reject `basis` outside the enum.
- Attach to rate plan; verify `rate_plan.meal_plan_id` is set; verify event `rate_plan.meal_plan_linked` fired.
- Tenant isolation: tenant B cannot see tenant A meal plans.

### Acceptance Criteria
- 259+ existing tests still pass.
- New `test/pms_meal_plans.test.js` ≥6 tests passing.
- Hooked into route `/api/pms/meal-plans` reachable through bus dispatch.

---

## Step 4 — Night-Audit Scheduler & Stale-Date Alert (C13)

### Deliverables
- Migration `0033_night_audit_schedule.sql` (helper index only — uses existing `scheduled_jobs`).
- Service `nightAuditScheduler.bootstrapForProperty(propertyId, {cron, timezone})` that inserts a recurring `scheduled_jobs` row whose handler dispatches `pms.night_audit.run`.
- Stale-date detector: scheduled job `pms.business_date.stale_check` runs hourly; when `properties.current_business_date < today - threshold`, emits `business_date.stale_detected` + writes a notification.
- Command `pms.night_audit.schedule` to (re)configure cron per property.
- Tests covering scheduling, stale detection, and the new command.

### Schemas
```sql
-- No new table; just a helpful index for the stale-check sweep.
CREATE INDEX IF NOT EXISTS idx_properties_business_date
  ON properties(current_business_date)
  WHERE current_business_date IS NOT NULL;
```

### Aggregates
- `night_audit_schedule` (single row per property, materialised in `settings`).

### Events
- `night_audit.schedule.configured` — payload `{property_id, cron, timezone}`.
- `business_date.stale_detected` — payload `{property_id, current_business_date, age_days, threshold_days}`.

### APIs
- `POST /api/pms/night-audit/schedule { cron, timezone }` — configures the recurring job.

### Permissions
- `night_audit.config` (already seeded migration 0030).

### Settings (registered in the catalog from Step 1)
- `night_audit.cron`         (string, default `'0 3 * * *'`)
- `night_audit.timezone`     (string, default `'UTC'`)
- `night_audit.stale_threshold_hours` (int, default `24`)
- `night_audit.auto_scheduler_enabled` (boolean, default `true`)

### Migration Impact
- Adds an index only.
- Adds rows to `scheduled_jobs` on first bootstrap call.

### Test Coverage Requirements
- `pms.night_audit.schedule` writes a `scheduled_jobs` row with `recurrence_rule` + correct timezone.
- Re-issuing the command updates the existing row (no duplicates).
- Stale-check detects a property with `current_business_date` ≥ threshold and emits the event.
- Stale-check is a no-op when within threshold.

### Acceptance Criteria
- 259+ existing tests still pass.
- `test/nightAuditSchedule.test.js` ≥5 tests passing.
- Event taxonomy still matches the single-dot regex.

---

## Step 5 — Audit + AI Hardening

### Deliverables
- Migration `0035_audit_indexes.sql` — property-scoped audit_events index.
- Migration `0036_ai_messages_revoke.sql` — `REVOKE UPDATE,DELETE FROM PUBLIC` on `ai_messages` and `ai_conversations`.
- Update `migrationValidation.test.js` expectations.

### Schemas
```sql
-- 0035
CREATE INDEX IF NOT EXISTS idx_audit_events_property_time
  ON audit_events(property_id, occurred_at DESC)
  WHERE property_id IS NOT NULL;

-- 0036
REVOKE UPDATE, DELETE ON ai_messages       FROM PUBLIC;
REVOKE UPDATE, DELETE ON ai_conversations  FROM PUBLIC;
```

### Aggregates / Events / APIs / Permissions / Settings
- None added.

### Migration Impact
- Index creation: non-blocking on small tables; safe.
- REVOKE: only PUBLIC affected. Application role (configured in env, typically `qyrvia_app`) retains its grants.

### Test Coverage Requirements
- `migrationValidation.test.js` extended to assert: append-only `ai_messages` + `ai_conversations` (REVOKE present), and that `audit_events.property_id` partial index exists in migrations.

### Acceptance Criteria
- All tests pass.
- No regression in `accountingSensitive.test.js`, `nightAudit.test.js`, `pms_checkin_folio.test.js`.

---

## Cross-Cutting Notes

1. **No fake AI** — Step 1 catalog will reject AI keys that try to register placeholder providers (e.g., `ai.copilot.fake_provider=true` won't pass).
2. **Backward compatibility** — every endpoint added is *additive*. Login endpoint extension is union-typed (`tenant_code` OR `property_code`); the existing tenant-code path remains the supported default until callers migrate.
3. **Property-ID enforcement** — every new command requires `ctx.propertyId` where the aggregate is property-scoped. Meal plans are property-scoped. The auth-switch handler validates target `property_id` against `user_roles`.
4. **Audit-enabled** — every new command emits domain events via `makeEvent({ctx})`; both audit_events and event_store receive copies.
5. **Business-date aware** — meal plan post-charge subscribers (later Phase 7 Folio work) will see `ctx.businessDate`; the schema is already business-date-ready.
6. **Settings Center sole source** — every new tunable lands in the catalog registry, no env-only or hard-coded defaults beyond bootstrap.

---

## Test Totals Targets

| Step | New tests (min) | Cumulative pass target |
|------|-----------------|------------------------|
| 1 — Settings catalog | +6  | 265 |
| 2 — Auth multi-property | +8 | 273 |
| 3 — Meal policy engine | +6 | 279 |
| 4 — Night-audit scheduler | +5 | 284 |
| 5 — Hardening | +2 (in migrationValidation) | 286 |

Final target: **≥ 286 / 286 backend tests passing.** Frontend unchanged.

---

## Done When

- All six migrations (0031–0036) committed.
- All step tests + existing tests pass green in one run.
- Updated `docs/QYRVIA_COMPLIANCE_ASSESSMENT.md` rows for C1–C4 / C13 / C14 flipped from ✗/◐ to ✓.
- Phase 6 completion report appended to `docs/ARCHITECTURE_READINESS.md`.

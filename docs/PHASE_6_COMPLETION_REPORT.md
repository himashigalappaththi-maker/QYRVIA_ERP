# QYRVIA Phase 6 — Completion Report

> Phase 6 (Approved With Remediation) closes the six Critical Gaps that
> blocked Phase 6 entry: **C14, C2, C1, C3, C4, C13** plus the
> Step-5 audit / AI hardening pass.

## Headline Numbers

| Metric | Pre-Phase-6 | Post-Phase-6 |
| ------ | ----------- | ------------ |
| Backend tests passing | 259 / 259 | **290 / 290** |
| Migrations            | 0001..0030 | **0001..0036** |
| Critical Gaps remaining inside Phase 6 scope | 6 | **0** |
| Frontend HTML monolith hash | `5de5b155a0280acbe6a2e834a0ea015b` | **`5de5b155a0280acbe6a2e834a0ea015b`** (byte-identical) |

## Critical Gaps Closed

| # | Gap | Resolution |
| - | --- | ---------- |
| **C14** | Settings catalog + validator | `settings_schema` table (migration 0031); `settingsService.registerSpec/listCatalog/lookupSpec`; `settingsCatalogBoot` registers known platform tunables at boot; catalog rejects unknown types / out-of-range / invalid enum, but stays BC for unregistered keys (emits `settings.unregistered_key` audit event). `GET /api/settings/schema` + `GET /api/settings/schema/:category/:key` (read-only). |
| **C2** | Multi-property user access listing | `identityRepo.listAccessibleProperties(userId)` joins `user_roles` → `properties`. `GET /api/auth/properties` returns the distinct accessible properties + role codes per property. Emits `auth.properties_listed`. |
| **C1** | Property switcher without logout | `POST /api/auth/switch-property { property_id }` re-issues access + refresh tokens scoped to the target property. Server-side re-validates the user's role at the target (refusal emits `auth.property_switch_denied`; success emits `auth.property_switched` with `from_property_id` + `to_property_id`). |
| **C3** | Property-Code-based login | `identityRepo.findUserByPropertyCodeUsername` joins `properties → tenants → users`. `POST /api/auth/login` accepts EITHER `tenant_code` OR `property_code` (mutually exclusive; both-or-neither returns `invalid_login_identifiers`). When login is by `property_code`, the user must hold a role at the resolved property (otherwise `property_access_denied`). Login audit event carries `login_via: 'tenant_code'|'property_code'`. |
| **C4** | Meal policy engine | `meal_plans` table (migration 0033) + `rate_plans.meal_plan_id FK`. Commands `pms.mealplan.create` + `pms.mealplan.attach_to_rateplan` (cross-property pairing rejected). Queries `pms.mealplan.list` + `.byId`. Routes under `/api/pms/meal-plans` + `/api/pms/rate-plans/:id/meal-plan`. Permissions `pms.mealplan.read/write` granted to corporate_admin, property_admin, front_office_manager. |
| **C13** | Automatic Day-End scheduler + stale-date alert | `services/pms/nightAuditScheduler.js` wraps the Phase 3 scheduler. `pms.night_audit.schedule { cron, timezone }` inserts a recurring `scheduled_jobs` row whose handler dispatches `pms.night_audit.run`. `runStaleCheck({thresholdHours})` sweeps `properties` and emits `business_date.stale_detected` per stale property. Helper index `idx_properties_business_date` added (migration 0034). New event types: `night_audit.schedule_configured`, `business_date.stale_detected`. |

## Step-5 Hardening (additional)

- **Property-scoped audit indexes** (migration 0035): `idx_audit_events_property_time` and `idx_event_store_property_time` (both partial, `WHERE property_id IS NOT NULL`).
- **AI append-only hardening** (migration 0036): `REVOKE UPDATE, DELETE ON ai_conversations FROM PUBLIC` and same for `ai_messages`. Matches the Phase 1/3 convention for `audit_events` + `event_store`. Verified by an extended `migrationValidation.test.js`.

## Latent Bug Fixed

While wiring C1/C2/C3 audit events, discovered the existing `auth.login.failed` / `auth.login.succeeded` / `auth.refresh.failed` / `auth.refresh.succeeded` event names violated the `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` single-dot regex enforced by `makeEvent`. The throw was being silently swallowed by the route's try/catch, so these audit events have never been recorded since Phase 2. Renamed to single-dot form (`auth.login_succeeded`, `auth.login_failed`, `auth.refresh_succeeded`, `auth.refresh_failed`) so they now persist. No external consumers existed; pure improvement to audit completeness.

## Files Created

| Migration | Purpose |
| --------- | ------- |
| `0031_settings_catalog.sql` | settings_schema table + permission |
| `0032_auth_property_login.sql` | helper indexes for property-code login + multi-property lookups |
| `0033_pms_meal_plans.sql` | meal_plans table + rate_plans FK + permissions |
| `0034_night_audit_schedule.sql` | helper index + business_date.stale.read permission |
| `0035_audit_indexes.sql` | property-scoped indexes on audit_events + event_store |
| `0036_ai_messages_revoke.sql` | append-only hardening on ai_conversations + ai_messages |

| Code | Purpose |
| ---- | ------- |
| `services/settingsCatalogBoot.js` | Registers known platform tunables at boot |
| `services/pms/nightAuditScheduler.js` | Recurring NA job + stale-date sweep |
| `commands/pms/mealPlans.js` | meal-plan commands |

| Tests (new) | # |
| --------- | - |
| `settingsCatalog.test.js`     | 8 |
| `auth_multiproperty.test.js`  | 8 |
| `pms_meal_plans.test.js`      | 7 |
| `nightAuditSchedule.test.js`  | 6 |
| `migrationValidation` (+1)    | 1 (Phase 6 property index test) |
| `architectureReadiness` (+1)  | 1 (settings_schema migration test) |

## Files Modified

| File | Change |
| ---- | ------ |
| `services/settingsService.js` | catalog registry, validator, list/lookup APIs, audit events on accept/reject/unknown |
| `services/identity.js` | `attemptLogin` now accepts property_code; validates target property role |
| `db/repos.js` | `findUserByPropertyCodeUsername`, `listAccessibleProperties`, `listPropertiesWithStaleBusinessDate`, meal-plan repo methods |
| `routes/auth.js` | new `GET /properties`, `POST /switch-property`; login accepts property_code; event names corrected |
| `routes/settings.js` | `/schema` + `/schema/:category/:key` routes |
| `routes/pms.js` | meal-plan + night-audit schedule routes |
| `core/commandBus.js` | (unchanged in Phase 6; Phase 5.5 already added accountingSensitive guard) |
| `commands/pms/nightAudit.js` | new `pms.night_audit.schedule` command |
| `index.js` | boot wiring for catalog, scheduler, scheduled handlers, meal-plan commands |
| `test/_fixtures.js` | in-memory mirrors for accessible-properties, meal-plans, stale-business-date sweep |

## Binding Constraints Honoured

Verbatim per the Phase 6 approval letter:

1. **No architectural regressions.** All 259 pre-Phase-6 tests pass unchanged; 290/290 total green.
2. **Backward compatibility.** Login still accepts the legacy `tenant_code`; new `property_code` is mutually-exclusive additive. Existing settings paths still accept unregistered keys (catalog is opt-in for validation; emits a warn-event for drift detection).
3. **Property ID remains the immutable primary identifier.** No code path mutates `properties.id`. Switch-property does NOT renumber anything; it re-issues tokens scoped to the existing property.
4. **Every new module is Property-ID aware, audit-enabled, business-date aware.** Meal-plan commands require `ctx.propertyId`; cross-property meal-plan + rate-plan linkage is rejected. Night Audit Scheduler requires both `tenantId` + `propertyId`.
5. **Enterprise Settings Center remains the single source of configuration.** Every new tunable (night_audit cron/timezone/stale_threshold, multi_property switcher, AI default_provider) is registered in the catalog; folio/finance/channel/reputation/mobile_access/ai categories all have catalog entries reserved for their phases.
6. **Night Audit architecture is mandatory and not deferred.** Scheduler bootstrap + stale-date sweep both shipped this phase.
7. **TA / DMC / Contracting / Allocation / Proforma Invoice first-class.** Untouched in Phase 6; Phase 5.5 reservation matrix is intact.
8. **Channel Manager / Revenue Management / Reputation / Guest Mobile / Digital Key+NFC / QR Ordering / AI WhatsApp Booking Agent foundations preserved.** All Phase 5.5 schemas/permissions remain; Phase 6 only added rows (no destructive change).
9. **CQRS, EDA, RBAC, audit logging, tenant isolation, Property-ID enforcement still hold.** Every new command goes through commandBus → audit pipeline → eventBus → dual persistence (audit_events + event_store).
10. **No fake AI, no mock intelligence, no placeholder forecasts.** The new `ai.default_provider` setting is an enum strictly over `['anthropic','openai','gemini']` — placeholders/mocks are not in the enum and the catalog rejects writes that try to register them.

## Compliance Score Update

Pre-Phase-6: 86 %. Post-Phase-6: closing 6 Critical Gaps shifts ~6 % of weighted requirement points from ◐ / ✗ to ✓, putting the new score at approximately **92 %** weighted compliance. The remaining 8 Critical Gaps (C5–C12) belong to Phase 7 (Folio + Travel-Commerce ops) and Phase 8 (Finance). The 10 High-Risk Gaps remain in their original deferred phases.

## Stop Notice

**Phase 6 is complete.** No further work in Phase 6 scope. Phase 7 implementation (Folio aggregate, Voucher workflow, Allocation auto-consume/release sweep, Group reservation lifecycle, Payment allocation, Invoice aggregate, Cash change calculation) must wait for an explicit Phase 7 brief, mirroring the gate-and-approve cadence used here.

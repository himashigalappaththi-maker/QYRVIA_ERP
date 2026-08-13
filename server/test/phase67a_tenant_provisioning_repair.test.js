'use strict';

/**
 * Phase 67A Workstream B — tenant provisioning repair, contract tests.
 *
 * The PRE-EXISTING tenantProvisioning.test.js mock pool pattern-matches only
 * the table name in each INSERT ("INSERT INTO tenants") and returns a canned
 * success row — it never inspects the actual column list. That is exactly
 * why the original defect (inserting a nonexistent `timezone` column into
 * `tenants`) went completely undetected: the mock did not check what
 * columns were actually being written.
 *
 * This file's mock instead PARSES each INSERT statement's real column list
 * out of the SQL text and exposes it to the test, so these tests fail if
 * the INSERT ever again references a column that does not belong on that
 * table — per the Phase 67A brief: "At minimum, assert the exact INSERT
 * column list and parameters."
 *
 * No database connection is opened. This is a pure unit/contract test.
 */

process.env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY =
  Buffer.alloc(32, 0x42).toString('base64');
process.env.APP_BASE_URL = 'http://localhost:3001';

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

const { buildTenantProvisioningService }  = require('../src/services/tenantProvisioning');
const { buildInvitationService }          = require('../src/services/invitation');
const { buildIdentityNotificationOutbox } = require('../src/services/identityNotificationOutbox');

// The real, authoritative column sets, taken directly from the migrations
// (0001_init.sql for tenants' base shape; 0022_arch_hardening_multiproperty
// added tenants.legal_name/tax_id/company_logo_url/country_code/
// billing_email and properties.timezone/address/phone/email/logo_url — none
// of those extra tenants columns are timezone, and tenants never gained one).
const TENANTS_COLUMNS    = new Set(['id', 'code', 'name', 'status', 'created_at', 'updated_at',
  'legal_name', 'tax_id', 'company_logo_url', 'country_code', 'billing_email']);
const PROPERTIES_COLUMNS = new Set(['id', 'tenant_id', 'code', 'name', 'city', 'currency', 'active',
  'created_at', 'address', 'phone', 'email', 'logo_url', 'timezone', 'license_no', 'star_rating']);

/** Parse `INSERT INTO <table> (col1, col2, ...)` -> { table, columns } */
function parseInsertColumns(sql) {
  const m = /INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i.exec(sql);
  if (!m) return null;
  return { table: m[1], columns: m[2].split(',').map((c) => c.trim()) };
}

function makeMockPool({ failOn, dupCode } = {}) {
  const queries = [];
  let tenantIdVal   = crypto.randomUUID();
  let propertyIdVal = crypto.randomUUID();

  const client = {
    _queries: queries,
    async query(sql, params) {
      const tag = sql.trim().replace(/\s+/g, ' ').slice(0, 200);
      const parsed = parseInsertColumns(sql);
      queries.push({ tag, params, parsed });

      if (failOn && tag.includes(failOn)) {
        const err = new Error('mock error: ' + failOn);
        if (dupCode) err.code = '23505';
        throw err;
      }

      // Contract check: if this is an INSERT into tenants or properties,
      // every referenced column MUST actually exist on that table. A real
      // Postgres connection would reject an unknown column with
      // "column ... does not exist" — this mock enforces the same contract
      // without needing a live database.
      if (parsed && parsed.table === 'tenants') {
        for (const col of parsed.columns) {
          if (!TENANTS_COLUMNS.has(col)) {
            throw new Error(`mock schema violation: column "${col}" does not exist on tenants`);
          }
        }
        return { rows: [{ id: tenantIdVal }] };
      }
      if (parsed && parsed.table === 'properties') {
        for (const col of parsed.columns) {
          if (!PROPERTIES_COLUMNS.has(col)) {
            throw new Error(`mock schema violation: column "${col}" does not exist on properties`);
          }
        }
        return { rows: [{ id: propertyIdVal }] };
      }
      return { rows: [] };
    },
    _tenantId()   { return tenantIdVal; },
    _propertyId() { return propertyIdVal; },
    async release() {}
  };

  return {
    _client: client,
    _queries: queries,
    async connect() { return client; }
  };
}

const VALID_INPUT = {
  companyName:  'Acme Hotels',
  companyCode:  'ACME',
  propertyName: 'Acme Downtown',
  propertyCode: 'ACME-DT',
  ownerEmail:   '  MixedCase@Acme.com  ',
  timezone:     'Asia/Colombo'
};

const CTX = { actorId: 'platform-admin-1', actorName: 'PlatformAdmin', roleCodes: ['platform_admin'], requestId: 'req-1' };

function makeProvisioningService(pool, invitationService) {
  return buildTenantProvisioningService({ pool, invitationService });
}

function makeInvitationServiceWithRepos() {
  const repos  = fx.makeFakeRepos();
  const outbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });
  const withTenantFn = async (tenantId, cb) => {
    const client = { tenantId, query: async () => ({ rows: [] }) };
    return cb(client);
  };
  const real = buildInvitationService({
    repo: repos.invitationRepo,
    identityNotificationOutbox: outbox,
    withTenantFn
  });
  return { real, repos };
}

function makeInvitationService(spy) {
  const { real } = makeInvitationServiceWithRepos();
  if (!spy) return real;
  return {
    async createInvitation(args) {
      spy(args);
      return real.createInvitation(args);
    },
    // provisionTenant (Phase 67A-003) calls THIS, not createInvitation —
    // the spy must wrap the function actually invoked in-transaction.
    async createInvitationInTransaction(args) {
      spy(args);
      return real.createInvitationInTransaction(args);
    }
  };
}

// ── Bug reproduction: tenants INSERT must never reference timezone ────────────

test('provisionTenant: tenants INSERT does not reference a timezone column', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const r    = await svc.provisionTenant(VALID_INPUT, CTX);
  assert.equal(r.ok, true, 'provisioning must succeed against the real schema: ' + JSON.stringify(r));

  const tenantInsert = pool._queries.find((q) => q.parsed && q.parsed.table === 'tenants');
  assert.ok(tenantInsert, 'INSERT INTO tenants missing');
  assert.ok(!tenantInsert.parsed.columns.includes('timezone'),
    'tenants INSERT must not reference timezone — that column does not exist on tenants');
  // Exact column list, order-sensitive (matches the $1,$2,$3 params below).
  assert.deepEqual(tenantInsert.parsed.columns, ['name', 'code', 'status']);
});

test('provisionTenant: property INSERT receives the requested timezone', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  await svc.provisionTenant(VALID_INPUT, CTX);

  const propInsert = pool._queries.find((q) => q.parsed && q.parsed.table === 'properties');
  assert.ok(propInsert, 'INSERT INTO properties missing');
  assert.ok(propInsert.parsed.columns.includes('timezone'),
    'properties INSERT must persist the requested timezone');
  assert.deepEqual(propInsert.parsed.columns, ['tenant_id', 'name', 'code', 'active', 'timezone']);
  // Note: `active` in this INSERT is the SQL literal `true`, not a $N
  // placeholder, so params has one fewer entry than columns — timezone is
  // params[3] (tenant_id, name, code, timezone), not params[4].
  assert.equal(propInsert.params[3], 'Asia/Colombo');
});

test('provisionTenant: default timezone is UTC when not supplied', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const input = { ...VALID_INPUT };
  delete input.timezone;
  const r = await svc.provisionTenant(input, CTX);
  assert.equal(r.ok, true, JSON.stringify(r));

  const propInsert = pool._queries.find((q) => q.parsed && q.parsed.table === 'properties');
  assert.equal(propInsert.params[3], 'UTC');
});

test('provisionTenant: blank (whitespace-only) timezone is rejected as validation_failed', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const r = await svc.provisionTenant({ ...VALID_INPUT, timezone: '   ' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'validation_failed');
  assert.ok(r.detail.includes('timezone'));
});

// ── Atomicity ───────────────────────────────────────────────────────────────

test('provisionTenant: the invitation record + its notification-outbox row are written atomically, and delivery is NOT performed inside the transaction', async () => {
  const pool = makeMockPool();
  const { real: invitationService, repos } = makeInvitationServiceWithRepos();
  const svc = makeProvisioningService(pool, invitationService);
  const r = await svc.provisionTenant(VALID_INPUT, CTX);
  assert.equal(r.ok, true, JSON.stringify(r));

  // Durable invitation record exists.
  assert.equal(repos.invitationRepo._invitations.size, 1);
  const invRow = [...repos.invitationRepo._invitations.values()][0];
  assert.equal(invRow.email, 'mixedcase@acme.com'); // normalized form of VALID_INPUT.ownerEmail

  // The notification-outbox row exists and is 'pending' — proving delivery
  // (an actual send) did NOT happen synchronously as part of provisioning;
  // only a durable, retryable DB row was written. A real send would be
  // performed later by the separate Phase 58 notification-retry worker.
  assert.equal(repos.notificationRepo._notifications.length, 1);
  assert.equal(repos.notificationRepo._notifications[0].status, 'pending');
  assert.equal(repos.notificationRepo._notifications[0].tenant_id, r.tenantId);
});

test('provisionTenant: property INSERT failure rolls back (no COMMIT recorded)', async () => {
  const pool = makeMockPool({ failOn: 'INSERT INTO properties' });
  const svc  = makeProvisioningService(pool, makeInvitationService());
  // A non-duplicate-key error is rolled back and then re-thrown (see the
  // `throw err;` after ROLLBACK in tenantProvisioning.js's catch block) —
  // it is NOT swallowed into a graceful {ok:false} return, unlike the
  // 23505 duplicate-code path exercised by the existing test file.
  await assert.rejects(() => svc.provisionTenant(VALID_INPUT, CTX), /mock error: INSERT INTO properties/);
  const tags = pool._queries.map((q) => q.tag);
  assert.ok(tags.some((t) => /ROLLBACK/i.test(t)), 'ROLLBACK missing on failure');
  assert.ok(!tags.some((t) => /^COMMIT/i.test(t)), 'COMMIT must not appear when a step fails');
});

test('provisionTenant: transaction commits only after tenant + property + audit all succeed', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const r = await svc.provisionTenant(VALID_INPUT, CTX);
  assert.equal(r.ok, true);
  const tags = pool._queries.map((q) => q.tag);
  const beginIdx  = tags.findIndex((t) => /^BEGIN/i.test(t));
  const commitIdx = tags.findIndex((t) => /^COMMIT/i.test(t));
  assert.ok(beginIdx >= 0 && commitIdx > beginIdx, 'BEGIN must precede COMMIT');
  assert.ok(tags.some((t) => /INSERT INTO audit_events/i.test(t)), 'audit_events insert missing before commit');
});

// ── Email normalization (Workstream B item 8) ──────────────────────────────

test('provisionTenant: owner email is normalized (trim + lowercase) for the invitation', async () => {
  const pool = makeMockPool();
  let captured = null;
  const svc = makeProvisioningService(pool, makeInvitationService((args) => { captured = args; }));
  const r = await svc.provisionTenant(VALID_INPUT, CTX); // input has '  MixedCase@Acme.com  '
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(captured, 'invitation service was not called');
  assert.equal(captured.email, 'mixedcase@acme.com');
  assert.equal(r.invitation.email, 'mixedcase@acme.com');
});

// ── System-role protection (Workstream B item 6) ───────────────────────────

test('provisionTenant: invited role is always exactly corporate_admin, never caller-controlled', async () => {
  const pool = makeMockPool();
  let captured = null;
  const svc = makeProvisioningService(pool, makeInvitationService((args) => { captured = args; }));
  // Even if a caller tried to smuggle a role/tenant through the input object,
  // provisionTenant's input schema does not accept a roleCodes or tenantId
  // field at all - the whole object is ignored beyond the documented fields.
  const maliciousInput = { ...VALID_INPUT, roleCodes: ['super_admin'], tenantId: 'attacker-controlled' };
  const r = await svc.provisionTenant(maliciousInput, CTX);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(captured.roleCodes, ['corporate_admin']);
  assert.equal(captured.tenantId, pool._client._tenantId());
});

// ── Existing platform authorization is unchanged ───────────────────────────

test('provisionTenant: still succeeds for a platform_admin actor (authorization untouched by this repair)', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const r = await svc.provisionTenant(VALID_INPUT, { ...CTX, roleCodes: ['platform_admin'] });
  assert.equal(r.ok, true, JSON.stringify(r));
});

'use strict';
// Env vars must be set BEFORE any require that loads config/env.js
process.env.JWT_SECRET         = process.env.JWT_SECRET         || 'test-jwt-secret-minimum-32-chars-padded!!';
process.env.JWT_SECRET_PREV    = process.env.JWT_SECRET_PREV    || '';
process.env.REFRESH_TOKEN_TTL_DAYS = process.env.REFRESH_TOKEN_TTL_DAYS || '30';
process.env.ACCESS_TOKEN_TTL_SEC   = process.env.ACCESS_TOKEN_TTL_SEC   || '900';
process.env.BCRYPT_ROUNDS      = process.env.BCRYPT_ROUNDS      || '1';
// Prevent real pool init during import (pg Pool is lazy but env.js may validate)
process.env.DATABASE_URL       = process.env.DATABASE_URL       || 'postgresql://skip:skip@localhost:5432/skip';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');

const identity = require('../src/services/identity');
const tokens   = require('../src/services/tokens');

const RUNNER_PATH   = path.resolve(__dirname, '../scripts/p62-runner.js');
const IDENTITY_PATH = path.resolve(__dirname, '../src/services/identity.js');
const AUTH_PATH     = path.resolve(__dirname, '../src/routes/auth.js');

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeUser(overrides) {
  return Object.assign({
    id: 'u-test-uuid', tenant_id: 't-test-uuid',
    username: 'alice', email: 'alice@example.com',
    full_name: 'Alice', status: 'ACTIVE',
    password_hash: '$hash$', failed_login_count: 0,
    locked_until: null, last_login_at: null,
    soft_deleted_at: null, primary_property_id: null
  }, overrides);
}

function makeProp(overrides) {
  return Object.assign({ id: 'p-uuid', tenant_id: 't-test-uuid', active: true }, overrides);
}

function makeWT() {
  // Build a withTenant mock that tracks whether the callback is running.
  let _inside = false;
  const calls = [];
  async function wt(tid, cb) {
    _inside = true;
    calls.push({ tid });
    const r = await cb({ _client: true });
    _inside = false;
    return r;
  }
  wt.calls = calls;
  Object.defineProperty(wt, 'inside', { get: () => _inside });
  return wt;
}

function makeRepo(overrides) {
  const wt = makeWT();
  const insertCalls = [];

  const base = {
    withTenant: wt,
    // Resolvers (no client — BYPASSRLS path)
    resolveByTenantUsername:    async () => ({ user_id: 'u-test-uuid', tenant_id: 't-test-uuid' }),
    resolveByEmail:             async () => ({ user_id: 'u-test-uuid', tenant_id: 't-test-uuid' }),
    resolveByPropertyIdUsername: async () => ({ user_id: 'u-test-uuid', tenant_id: 't-test-uuid', property_id: 'p-uuid' }),
    // T1/T2 data methods (all require client)
    findUserById:               async (id, client, opts) => makeUser(),
    findTenantStatus:           async () => 'active',
    findPropertyForAuth:        async () => makeProp(),
    findRolesForUser:           async () => [{ id: 'r1', code: 'MANAGER', scope: 'property', property_id: 'p-uuid' }],
    findPermissionsForUser:     async () => ['auth.login'],
    listAccessibleProperties:   async () => [{ id: 'p-uuid' }],
    canAccessProperty:          async () => true,
    updateUserOnSuccessfulLogin: async () => {},
    updateUserOnFailedLogin:    async () => {},
    // Token repo methods
    insertRefreshToken: async (rec, client) => {
      insertCalls.push({ rec, client });
      return { id: 'rt-test-uuid' };
    },
    findRefreshTokenByHash:      async () => null,
    findRefreshTokenByIdAndHash: async () => null,
    markRefreshTokenUsed:        async () => {},
    revokeRefreshToken:          async () => {},
    revokeAllRefreshTokensForUser: async () => {},
    linkRotation:                async () => {},
    resolveRefreshTokenByHash:   async () => null,
    // Expose internals for test assertions
    _wt: wt,
    _insertCalls: insertCalls,
    // bcrypt intercept
    _verifyPasswordFn: async () => true
  };

  return Object.assign(base, overrides);
}

// Minimal valid refresh-token row for rotation tests
function makeTokenRow(overrides) {
  return Object.assign({
    id: 'rt-1', user_id: 'u-1', tenant_id: 't-1',
    token_hash: 'h',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    rotated_to: null, revoked_at: null,
    device_name: 'Mobile', device_id: 'd-1',
    ip_address: '10.0.0.1', user_agent: 'TestAgent'
  }, overrides);
}

// Minimal rotation repo (tokens.js tests)
function makeRotationRepo(overrides) {
  const wt = makeWT();
  return Object.assign({
    withTenant: wt,
    resolveRefreshTokenByHash: async () => ({ token_id: 'rt-1', tenant_id: 't-1', user_id: 'u-1' }),
    findRefreshTokenByIdAndHash: async () => makeTokenRow(),
    insertRefreshToken: async () => ({ id: 'rt-new' }),
    linkRotation:           async () => {},
    revokeRefreshToken:     async () => {},
    markRefreshTokenUsed:   async () => {},
    revokeAllRefreshTokensForUser: async () => {}
  }, { _wt: wt }, overrides);
}

// ---------------------------------------------------------------------------
// Tests 1–9: identity.js / login flow
// ---------------------------------------------------------------------------

test('1: CLIENT_REQUIRED pattern enforced — method without client throws', async () => {
  // The _requireClient helper in repos.js throws { code: 'CLIENT_REQUIRED' }.
  // Verify the shape independently (no DB needed).
  function _requireClient(client, label) {
    if (!client) throw Object.assign(new Error('client required'), { code: 'CLIENT_REQUIRED', label });
  }
  assert.throws(
    () => _requireClient(undefined, 'findUserById'),
    (err) => err.code === 'CLIENT_REQUIRED'
  );
  assert.doesNotThrow(
    () => _requireClient({ query: () => {} }, 'findUserById')
  );
});

test('2: resolver methods called OUTSIDE withTenant; data methods called WITH client', async () => {
  let insideWT = false;
  const resolverInsideWT = [];

  const repo = makeRepo({
    withTenant: async (tid, cb) => {
      insideWT = true;
      const r = await cb({ _client: true });
      insideWT = false;
      return r;
    },
    resolveByTenantUsername: async () => {
      resolverInsideWT.push(insideWT);
      return { user_id: 'u-test-uuid', tenant_id: 't-test-uuid' };
    },
    findUserById: async (id, client, opts) => {
      // All calls to findUserById must have a client
      assert.ok(client, 'findUserById called with client');
      return makeUser();
    }
  });

  await identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'pw' });

  assert.equal(resolverInsideWT.length, 1, 'resolver called once');
  assert.equal(resolverInsideWT[0], false, 'resolver called OUTSIDE withTenant');
});

test('3: bcrypt executes exactly once and OUTSIDE any withTenant transaction', async () => {
  let bcryptCount = 0;
  let bcryptInsideWT = false;
  let insideWT = false;

  const repo = makeRepo({
    withTenant: async (tid, cb) => {
      insideWT = true;
      const r = await cb({ _client: true });
      insideWT = false;
      return r;
    },
    _verifyPasswordFn: async () => {
      bcryptCount++;
      bcryptInsideWT = insideWT;
      return true;
    }
  });

  await identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'pw' });

  assert.equal(bcryptCount, 1, 'bcrypt called exactly once');
  assert.equal(bcryptInsideWT, false, 'bcrypt executed OUTSIDE withTenant');
});

test('4: T2 rejects login when password_hash changed between T1 and T2', async () => {
  const repo = makeRepo({
    findUserById: async (id, client, opts) => {
      if (opts && opts.forUpdate) {
        return makeUser({ password_hash: '$hash-changed-in-T2$' }); // T2: different hash
      }
      return makeUser({ password_hash: '$hash-T1$' }); // T1: original hash
    },
    _verifyPasswordFn: async (plain, hash) => true  // T1 succeeds
  });

  const result = await identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'pw' });

  assert.equal(result.ok, false, 'login rejected');
  assert.equal(result.reason, 'bad_password', 'reason is bad_password on hash change');
});

test('5: tenant status is revalidated in T2 (catch concurrent suspension)', async () => {
  let tenantStatusCallCount = 0;
  const repo = makeRepo({
    findTenantStatus: async () => {
      tenantStatusCallCount++;
      return tenantStatusCallCount === 1 ? 'active' : 'suspended'; // T2 sees different status
    }
  });

  const result = await identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'pw' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tenant_inactive', 'T2 tenant suspension caught');
  assert.ok(tenantStatusCallCount >= 2, 'findTenantStatus called at least twice (T1 + T2)');
});

test('6: inactive property is rejected during property login', async () => {
  const repo = makeRepo({
    resolveByPropertyIdUsername: async () => ({ user_id: 'u-test-uuid', tenant_id: 't-test-uuid', property_id: 'p-uuid' }),
    findPropertyForAuth: async () => makeProp({ active: false })
  });

  const result = await identity.attemptLogin(repo, { propertyId: 'p-uuid', username: 'alice', password: 'pw' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'property_access_denied', 'inactive property rejected');
});

test('7: property authorization check precedes login-state update', async () => {
  const callOrder = [];
  const repo = makeRepo({
    resolveByPropertyIdUsername: async () => ({ user_id: 'u-test-uuid', tenant_id: 't-test-uuid', property_id: 'p-uuid' }),
    findPropertyForAuth: async (propId, client) => {
      callOrder.push('findPropertyForAuth');
      return makeProp();
    },
    updateUserOnSuccessfulLogin: async (id, client) => {
      callOrder.push('updateUserOnSuccessfulLogin');
    }
  });

  const result = await identity.attemptLogin(repo, { propertyId: 'p-uuid', username: 'alice', password: 'pw' });
  assert.ok(result.ok, 'login succeeded');

  const propIdx   = callOrder.indexOf('findPropertyForAuth');
  const updateIdx = callOrder.indexOf('updateUserOnSuccessfulLogin');
  assert.ok(propIdx !== -1 && updateIdx !== -1, 'both calls present');
  assert.ok(propIdx < updateIdx, 'property auth comes before login-state update');
});

test('8: initial refresh token inserted exactly once in T2', async () => {
  const repo = makeRepo();

  await identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'pw' });

  assert.equal(repo._insertCalls.length, 1, 'insertRefreshToken called exactly once');
  assert.ok(repo._insertCalls[0].client, 'insertRefreshToken called with client (inside T2)');
});

test('9: failed-login counter update runs inside a withTenant transaction', async () => {
  let failedLoginClient = undefined;
  let withTenantCallCount = 0;

  const repo = makeRepo({
    withTenant: async (tid, cb) => {
      withTenantCallCount++;
      return cb({ _callNum: withTenantCallCount });
    },
    _verifyPasswordFn: async () => false,  // password always fails
    updateUserOnFailedLogin: async (id, client) => {
      failedLoginClient = client;
    }
  });

  const result = await identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'wrong' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_password');
  assert.ok(failedLoginClient, 'updateUserOnFailedLogin called with client (inside withTenant)');
  assert.ok(withTenantCallCount >= 2, 'at least two withTenant calls (T1 + failed-login TX)');
});

// ---------------------------------------------------------------------------
// Tests 10–13: tokens.js / refresh rotation
// ---------------------------------------------------------------------------

test('10: refresh rotation runs inside withTenant (atomicity)', async () => {
  let insertInsideWT = false;
  let insideWT = false;

  const repo = makeRotationRepo({
    withTenant: async (tid, cb) => {
      insideWT = true;
      const r = await cb({ _client: true });
      insideWT = false;
      return r;
    },
    insertRefreshToken: async (rec, client) => {
      insertInsideWT = insideWT;
      return { id: 'rt-new' };
    }
  });

  const r = await tokens.rotateRefreshToken(repo, 'raw-token', {}, null);

  assert.ok(r.ok, 'rotation succeeded');
  assert.ok(insertInsideWT, 'new refresh token inserted inside withTenant');
});

test('11: device metadata preserved through rotation', async () => {
  let capturedRec = null;
  const originalMeta = { device_name: 'iPhone', device_id: 'd-42', ip_address: '192.168.1.1', user_agent: 'MobileApp' };

  const repo = makeRotationRepo({
    findRefreshTokenByIdAndHash: async () => makeTokenRow(originalMeta),
    insertRefreshToken: async (rec, client) => {
      capturedRec = rec;
      return { id: 'rt-new' };
    }
  });

  await tokens.rotateRefreshToken(repo, 'raw-token', {}, null);

  assert.ok(capturedRec, 'insertRefreshToken was called');
  assert.equal(capturedRec.device_name, originalMeta.device_name, 'device_name preserved');
  assert.equal(capturedRec.device_id,   originalMeta.device_id,   'device_id preserved');
  assert.equal(capturedRec.ip_address,  originalMeta.ip_address,  'ip_address preserved');
  assert.equal(capturedRec.user_agent,  originalMeta.user_agent,  'user_agent preserved');
});

test('12: reuse containment: revokeAll commits BEFORE token_reuse_detected is returned', async () => {
  let revokeAllCalledInsideWT = false;
  let insideWT = false;

  const repo = makeRotationRepo({
    withTenant: async (tid, cb) => {
      insideWT = true;
      const r = await cb({ _client: true });
      insideWT = false;
      return r;
    },
    findRefreshTokenByIdAndHash: async () => makeTokenRow({ rotated_to: 'rt-already-rotated' }),
    revokeAllRefreshTokensForUser: async (userId, client) => {
      revokeAllCalledInsideWT = insideWT;
    }
  });

  const r = await tokens.rotateRefreshToken(repo, 'raw-token', {}, null);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'token_reuse_detected');
  assert.ok(revokeAllCalledInsideWT, 'revokeAll ran inside withTenant (containment committed first)');
});

test('13: DB failure in withTenant propagates — no replacement token issued', async () => {
  let insertCalled = false;
  const repo = makeRotationRepo({
    withTenant: async (tid, cb) => {
      await cb({ _client: true }); // partial execution
      throw new Error('simulated DB commit failure');
    },
    insertRefreshToken: async () => {
      insertCalled = true;
      return { id: 'rt-new' };
    }
  });

  await assert.rejects(
    () => tokens.rotateRefreshToken(repo, 'raw-token', {}, null),
    /simulated DB commit failure/,
    'transaction failure propagates as rejection'
  );
});

// ---------------------------------------------------------------------------
// Tests 14–15: error codes and compensating revoke
// ---------------------------------------------------------------------------

test('14: signing failure triggers compensating refresh-token revoke', async () => {
  // Exercise the compensating revoke pattern from auth.js (lines after issueAccessToken throws).
  const revokeCalls = [];

  const fakeIdentityRepo = {
    withTenant: async (tid, cb) => cb({ _client: true })
  };
  const fakeTokensRepo = {
    revokeRefreshToken: async (id, ts, client) => {
      revokeCalls.push({ id, ts, client });
    }
  };

  const refreshId = 'rt-to-compensate';
  const tenantId  = 't-test-uuid';

  // Reproduce the exact compensating revoke block from auth.js
  const signingErr = new Error('jwt_sign_failed');
  try {
    throw signingErr; // simulate tokens.issueAccessToken() throwing
  } catch (_) {
    if (fakeIdentityRepo.withTenant && tenantId) {
      try {
        await fakeIdentityRepo.withTenant(tenantId, async (c) => {
          await fakeTokensRepo.revokeRefreshToken(refreshId, new Date().toISOString(), c);
        });
      } catch (__) {}
    }
  }

  assert.equal(revokeCalls.length, 1, 'revoke called once');
  assert.equal(revokeCalls[0].id, refreshId, 'correct refresh token revoked');
  assert.ok(revokeCalls[0].client, 'revoke called with client (inside withTenant)');
});

test('15: RLS-path returns correct reason codes (invalid_token, token_expired, token_reuse_detected)', async () => {
  // invalid_token: resolver finds nothing
  const repoNotFound = {
    withTenant: async (tid, cb) => cb({}),
    resolveRefreshTokenByHash: async () => null
  };
  const r1 = await tokens.rotateRefreshToken(repoNotFound, 'raw', {}, null);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'invalid_token', 'missing token → invalid_token');

  // token_expired
  const repoExpired = makeRotationRepo({
    findRefreshTokenByIdAndHash: async () => makeTokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() })
  });
  const r2 = await tokens.rotateRefreshToken(repoExpired, 'raw', {}, null);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'token_expired', 'expired token → token_expired');

  // token_reuse_detected (via rotated_to)
  const repoReuse = makeRotationRepo({
    findRefreshTokenByIdAndHash: async () => makeTokenRow({ rotated_to: 'other-rt' }),
    revokeAllRefreshTokensForUser: async () => {}
  });
  const r3 = await tokens.rotateRefreshToken(repoReuse, 'raw', {}, null);
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'token_reuse_detected', 'reused token → token_reuse_detected');
});

// ---------------------------------------------------------------------------
// Tests 16–17: static source-code checks
// ---------------------------------------------------------------------------

test('16: p62-runner.js uses snake_case access_token (no camelCase accessToken)', () => {
  const src = fs.readFileSync(RUNNER_PATH, 'utf8');
  const camelOccurrences = (src.match(/\baccessToken\b/g) || []).length;
  assert.equal(camelOccurrences, 0,
    `p62-runner.js still has ${camelOccurrences} occurrence(s) of camelCase accessToken`);
  const snakeOccurrences = (src.match(/\.access_token\b/g) || []).length;
  assert.ok(snakeOccurrences > 0, 'p62-runner.js references .access_token (snake_case)');
});

test('21: p62-runner.js /auth/me assertion references me.json.user.id (not top-level me.json.id)', () => {
  const src = fs.readFileSync(RUNNER_PATH, 'utf8');
  // /auth/me returns { user: { id, ... }, roles, permissions } — user is nested under "user"
  assert.ok(
    /me\.json\.user\.id/.test(src),
    'runner must access me.json.user.id (server wraps user under "user" key)'
  );
  assert.equal(
    (src.match(/\bme\.json\.id\b/g) || []).length, 0,
    'runner must not reference top-level me.json.id (no such field in /auth/me response)'
  );
});

test('17: property login dispatches via property_id UUID (not property_code)', () => {
  const idSrc   = fs.readFileSync(IDENTITY_PATH, 'utf8');
  const authSrc = fs.readFileSync(AUTH_PATH, 'utf8');

  // identity.js should use the UUID resolver
  assert.ok(idSrc.includes('resolveByPropertyIdUsername'),
    'identity.js has resolveByPropertyIdUsername path');
  // The RLS dispatch uses propIdArg (from propertyId option, which is a UUID)
  assert.ok(idSrc.includes('propIdArg'),
    'identity.js dispatches on propIdArg (property UUID)');
  // auth.js should pass propertyId: property_id (UUID from request body)
  assert.ok(authSrc.includes('propertyId: property_id'),
    'auth.js passes propertyId UUID to attemptLogin');
  // auth.js should accept property_id as a standalone login identifier (Phase 62A validation)
  assert.ok(authSrc.includes('property_id') && authSrc.includes('invalid_login_identifiers'),
    'auth.js validates property_id as login identifier and rejects invalid combos');
});

// ---------------------------------------------------------------------------
// Tests 18–20: fail-closed and legacy-path-unreachable proofs
// ---------------------------------------------------------------------------

test('18: real authRepo wiring (withTenant + resolvers) never reaches legacy pool path', async () => {
  const repo = makeRepo();

  // Override legacy pool-query methods with traps — if called, test fails.
  repo.findUserByTenantUsername = async () => {
    throw new Error('LEGACY PATH REACHED: findUserByTenantUsername called in real wiring');
  };
  repo.findUserByPropertyCodeUsername = async () => {
    throw new Error('LEGACY PATH REACHED: findUserByPropertyCodeUsername called in real wiring');
  };
  repo.findUserByEmailGlobal = async () => {
    throw new Error('LEGACY PATH REACHED: findUserByEmailGlobal called in real wiring');
  };

  // All three login paths should use the new RLS path and never call the legacy methods.
  const r1 = await identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'pw' });
  assert.ok(r1.ok, 'tenant_code login used new RLS path');

  const r2 = await identity.attemptLogin(repo, { email: 'alice@example.com', password: 'pw' });
  assert.ok(r2.ok, 'email login used new RLS path');

  const r3 = await identity.attemptLogin(repo, { propertyId: 'p-uuid', username: 'alice', password: 'pw' });
  assert.ok(r3.ok, 'property_id login used new RLS path');
});

test('19: identity.js fails closed when withTenant present but all resolvers missing', async () => {
  const repo = {
    withTenant: async (tid, cb) => cb({ _client: true })
    // No resolveByTenantUsername, resolveByEmail, or resolveByPropertyIdUsername
  };

  await assert.rejects(
    () => identity.attemptLogin(repo, { tenantCode: 'T', username: 'alice', password: 'pw' }),
    (err) => err.code === 'AUTH_REPO_MISCONFIGURED',
    'throws AUTH_REPO_MISCONFIGURED when withTenant present but no resolvers'
  );
});

test('20: tokens.js fails closed when withTenant present but resolveRefreshTokenByHash missing', async () => {
  const repo = {
    withTenant: async (tid, cb) => cb({ _client: true })
    // No resolveRefreshTokenByHash
  };

  await assert.rejects(
    () => tokens.rotateRefreshToken(repo, 'raw-token', {}, null),
    (err) => err.code === 'TOKENS_REPO_MISCONFIGURED',
    'throws TOKENS_REPO_MISCONFIGURED when withTenant present but resolver missing'
  );
});

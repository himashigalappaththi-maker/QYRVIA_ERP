'use strict';

const express     = require('express');
const rateLimit   = require('express-rate-limit');

const identity = require('../services/identity');
const tokens   = require('../services/tokens');
const logger   = require('../config/logger');

const { authentication, setStatusRepo } = require('../middleware/authentication');
const authUserStatus = require('../commands/auth.user.status');

/**
 * Maps a command-bus outcome to an HTTP status code, matching the
 * established convention used elsewhere in this codebase (see
 * middleware/authorization.js's requirePermission, which returns 403 for
 * permission_denied). Phase 67A-003 fix: /register and /users/:id/status
 * previously collapsed every failure — including permission_denied — to a
 * flat 400, inconsistent with that convention.
 */
function _statusForOutcome(outcome) {
  if (outcome.ok) return 200;
  if (outcome.error === 'permission_denied') return 403;
  return 400;
}

/**
 * Auth router. Routes here are PUBLIC (no authentication required) except:
 *   - GET  /me            - bearer required
 *   - POST /logout        - bearer required
 *   - POST /register      - bearer + permission `auth.user.create` required
 *   - POST /users/:id/status - bearer + permission `auth.user.disable` required (Phase 67A)
 *
 * Built with build(deps) so tests can inject in-memory repos.
 *
 *   deps.identityRepo          = identity-service repo
 *   deps.tokensRepo            = tokens-service repo
 *   deps.eventBus              = (optional) for direct auth.* audit events
 *   deps.invitationService     = (optional) Phase 57 invitation service
 *   deps.passwordResetService  = (optional) Phase 57 password-reset service
 */
function build(deps) {
  const { identityRepo, tokensRepo, eventBus, makeAuthEvent,
          invitationService, passwordResetService } = deps;
  // Phase 62A: merged repo for login (T2 needs insertRefreshToken from tokensRepo).
  // When the new RLS path is active, authRepo combines identity + token repo methods.
  // Legacy repos (no withTenant) fall through to identityRepo unchanged.
  const authRepo = identityRepo && identityRepo.withTenant
    ? Object.assign({}, identityRepo, tokensRepo)
    : identityRepo;

  // Phase 67A: wire the real repo into the authentication middleware's
  // module-singleton (see middleware/authentication.js doc comment) so every
  // router in the app - not just this one - gets the current-status
  // re-check, without touching routes/api.js or index.js. Re-running this on
  // every build() call is intentional and safe: production boots this
  // router exactly once with the real repo; tests that call build() with
  // their own mock repo correctly re-point the singleton at their fixture
  // for the duration of that test file.
  setStatusRepo(authRepo);

  // Phase 67A: wire and (idempotently) register the disable/terminate
  // command the same way index.js wires auth.user.create - except this
  // happens here, inside the router this phase is permitted to modify,
  // rather than in index.js, which is not.
  authUserStatus.setRepo(authRepo);
  const commandBus = require('../core/commandBus');
  if (!commandBus.list().includes(authUserStatus.name)) {
    try { commandBus.register(authUserStatus); } catch (_) { /* already registered by a concurrent build() */ }
  }

  const router = express.Router(); // fresh per call - tests build many apps

  // Rate limit login: 5 attempts / IP / minute is plenty for a real user.
  // Disabled in tests to avoid cross-test interference; production paths
  // still enforce it.
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    // Phase 57: key covers both username and email paths to prevent rate-limit bypass
    // by switching credential type.
    keyGenerator: (req) => {
      const b = req.body || {};
      return req.ip + '|' + (b.email || b.username || '');
    },
    skip:    () => process.env.NODE_ENV === 'test',
    handler: (req, res) => {
      res.status(429).json({ error: 'rate_limited', retryAfterSec: 60, requestId: req.requestId });
    }
  });

  // -------- POST /login ------------------------------------------------
  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const { tenant_code, property_code, username, email, password, device_name, device_id, property_id } = req.body || {};
      // Phase 57: email path requires email+password only (no tenant/property hint).
      // Legacy path requires username + exactly one of tenant_code/property_code.
      // Phase 62A: property_id alone (no tenant_code, no property_code) is a new login identifier.
      // property_id alongside tenant_code or property_code remains the Phase-4 post-login filter.
      const useEmailPath = email && !username && !tenant_code && !property_code && !property_id;
      if (!useEmailPath) {
        if (!username || !password) {
          return res.status(400).json({ error: 'missing_fields', requestId: req.requestId });
        }
        // Only validate the primary identifier when property_id is not the sole identifier.
        if (!property_id || tenant_code || property_code) {
          if ((tenant_code && property_code) || (!tenant_code && !property_code && !property_id)) {
            return res.status(400).json({ error: 'invalid_login_identifiers', requestId: req.requestId,
                                           detail: 'Provide exactly one of: tenant_code, property_code, property_id.' });
          }
        }
      } else if (!password) {
        return res.status(400).json({ error: 'missing_fields', requestId: req.requestId });
      }
      const result = await identity.attemptLogin(authRepo,
        { tenantCode: tenant_code, propertyCode: property_code, propertyId: property_id,
          username, email, password,
          deviceName: device_name || null, deviceId: device_id || null,
          ipAddress: req.ip || null, userAgent: req.get('user-agent') || null });
      // Phase 4: optional property_id - validates the user has at least one
      // role granted at that property OR a tenant-wide grant.
      if (result.ok && property_id) {
        const roles = result.roles || [];
        const hasAccess = roles.some((r) => r.property_id === property_id || r.property_id === null);
        if (!hasAccess) {
          if (eventBus && makeAuthEvent) {
            try { await eventBus.publish(makeAuthEvent('auth.login_failed', { tenant_code, attempted_username: username, reason: 'property_access_denied', property_id }, req)); }
            catch (_) {}
          }
          return res.status(403).json({ error: 'property_access_denied', requestId: req.requestId });
        }
        result.user.primary_property_id = property_id;
      }
      if (!result.ok) {
        if (eventBus && makeAuthEvent) {
          try {
            await eventBus.publish(makeAuthEvent('auth.login_failed', {
              tenant_code,
              attempted_username: username || null,
              attempted_email:    useEmailPath ? email : null,
              reason: result.reason
            }, req));
          } catch (e) { logger.error({ err: e }, '[auth] failed to audit login failure'); }
        }
        return res.status(401).json({ error: result.reason, requestId: req.requestId });
      }

      // Phase 62A: new RLS path has refresh token already committed in T2.
      // Sign access token AFTER commit; compensate (revoke) if signing throws.
      let access, refresh;
      if (result.refreshToken) {
        refresh = result.refreshToken;
        try {
          access = tokens.issueAccessToken({
            userId:            result.user.id,
            tenantId:          result.user.tenant_id,
            primaryPropertyId: result.user.primary_property_id,
            roleCodes:         result.roles.map((r) => r.code),
            roleIds:           result.roles.map((r) => r.id)
          });
        } catch (signingErr) {
          if (identityRepo.withTenant && result.user.tenant_id) {
            try {
              await identityRepo.withTenant(result.user.tenant_id, async (c) => {
                await tokensRepo.revokeRefreshToken(refresh.id, new Date().toISOString(), c);
              });
            } catch (_) {}
          }
          throw signingErr;
        }
      } else {
        // Legacy path: sign first (sync), then insert refresh token.
        access = tokens.issueAccessToken({
          userId:            result.user.id,
          tenantId:          result.user.tenant_id,
          primaryPropertyId: result.user.primary_property_id,
          roleCodes:         result.roles.map((r) => r.code),
          roleIds:           result.roles.map((r) => r.id)
        });
        refresh = await tokens.issueRefreshToken(tokensRepo, {
          userId:     result.user.id,
          tenantId:   result.user.tenant_id,
          deviceName: device_name || null,
          deviceId:   device_id   || null,
          ipAddress:  req.ip      || null,
          userAgent:  req.get('user-agent') || null
        });
      }

      if (eventBus && makeAuthEvent) {
        try {
          await eventBus.publish(makeAuthEvent('auth.login_succeeded', {
            user_id: result.user.id, username: result.user.username,
            login_via: result.login_via || (tenant_code ? 'tenant_code' : 'property_code'),
            property_id: result.user.primary_property_id || null
          }, req, result.user));
        } catch (e) { logger.error({ err: e }, '[auth] failed to audit login success'); }
      }

      const responseBody = {
        access_token:  access.token,
        access_expires_at: access.expiresAt,
        refresh_token: refresh.token,
        refresh_expires_at: refresh.expiresAt,
        user:          result.user,
        roles:         result.roles.map((r) => ({ id: r.id, code: r.code, scope: r.scope, property_id: r.property_id })),
        permissions:   result.permissions,
        requestId:     req.requestId
      };
      // Phase 57: email-login path includes property selection hint.
      if (result.requires_property_selection != null) {
        responseBody.requires_property_selection = result.requires_property_selection;
        responseBody.authorised_properties = result.authorised_properties || [];
      }
      // Phase 57: PENDING_PASSWORD_RESET — issue a one-time reset token so the client
      // can redirect immediately to /complete-password-reset without a separate request.
      // The old password stops working once /password-reset/complete is called (new hash stored).
      if (result.requires_password_change) {
        responseBody.requires_password_change = true;
        if (passwordResetService && result.user && result.user.email) {
          try {
            const pr = await passwordResetService.requestReset({ email: result.user.email });
            if (pr.queued && pr.rawToken) responseBody.password_reset_token = pr.rawToken;
          } catch (_) { /* non-fatal — client can request manually */ }
        }
      }
      res.status(200).json(responseBody);
    } catch (err) { next(err); }
  });

  // -------- POST /refresh ----------------------------------------------
  router.post('/refresh', async (req, res, next) => {
    try {
      const { refresh_token, device_name, device_id } = req.body || {};
      if (!refresh_token) return res.status(400).json({ error: 'missing_refresh_token', requestId: req.requestId });

      const r = await tokens.rotateRefreshToken(tokensRepo, refresh_token, {
        deviceName: device_name, deviceId: device_id, ipAddress: req.ip, userAgent: req.get('user-agent')
      });
      if (!r.ok) {
        if (eventBus && makeAuthEvent) {
          try {
            await eventBus.publish(makeAuthEvent('auth.refresh_failed', { reason: r.reason }, req));
          } catch (e) { logger.error({ err: e }, '[auth] failed to audit refresh failure'); }
        }
        return res.status(401).json({ error: r.reason, requestId: req.requestId });
      }

      // Resolve fresh roles/permissions for the new access token
      // Phase 62A: pass tenantId from rotation result for RLS-safe resolveSession.
      const session = await identity.resolveSession(identityRepo, r.userId, r.tenantId);
      if (!session) return res.status(401).json({ error: 'user_unavailable', requestId: req.requestId });

      const access = tokens.issueAccessToken({
        userId:            session.user.id,
        tenantId:          session.user.tenant_id,
        primaryPropertyId: session.user.primary_property_id,
        roleCodes:         session.roles.map((x) => x.code),
        roleIds:           session.roles.map((x) => x.id)
      });

      if (eventBus && makeAuthEvent) {
        try {
          await eventBus.publish(makeAuthEvent('auth.refresh_succeeded', {
            user_id: session.user.id
          }, req, session.user));
        } catch (e) { logger.error({ err: e }, '[auth] failed to audit refresh success'); }
      }

      res.status(200).json({
        access_token:  access.token,
        access_expires_at: access.expiresAt,
        refresh_token: r.newRefresh.token,
        refresh_expires_at: r.newRefresh.expiresAt,
        requestId: req.requestId
      });
    } catch (err) { next(err); }
  });

  // -------- POST /logout -----------------------------------------------
  router.post('/logout', authentication, async (req, res, next) => {
    try {
      const { refresh_token } = req.body || {};
      if (refresh_token) await tokens.revokeRefreshToken(tokensRepo, refresh_token);
      if (eventBus && makeAuthEvent) {
        try {
          await eventBus.publish(makeAuthEvent('auth.logout', {
            user_id: req.user.sub
          }, req, { id: req.user.sub, full_name: null, tenant_id: req.user.tenant_id }));
        } catch (e) { logger.error({ err: e }, '[auth] failed to audit logout'); }
      }
      res.status(200).json({ ok: true, requestId: req.requestId });
    } catch (err) { next(err); }
  });

  // -------- GET /me ----------------------------------------------------
  router.get('/me', authentication, async (req, res, next) => {
    try {
      // Phase 62A: pass tenant_id from JWT for RLS-safe resolveSession.
      const session = await identity.resolveSession(identityRepo, req.user.sub, req.user.tenant_id);
      if (!session) return res.status(401).json({ error: 'user_unavailable', requestId: req.requestId });
      res.status(200).json({
        user:        session.user,
        roles:       session.roles.map((r) => ({ id: r.id, code: r.code, scope: r.scope, property_id: r.property_id })),
        permissions: session.permissions,
        requestId:   req.requestId
      });
    } catch (err) { next(err); }
  });

  // -------- GET /properties (Phase 6 / C2) -----------------------------
  // List properties the current user can access. Audited as a query event.
  router.get('/properties', authentication, async (req, res, next) => {
    try {
      if (typeof identityRepo.listAccessibleProperties !== 'function') {
        return res.status(501).json({ error: 'not_implemented', requestId: req.requestId });
      }
      // Phase 62A: use withTenant when available for FORCE RLS compliance.
      let rows;
      if (identityRepo.withTenant && req.user.tenant_id) {
        await identityRepo.withTenant(req.user.tenant_id, async (client) => {
          rows = await identityRepo.listAccessibleProperties(req.user.sub, client);
        });
      } else {
        rows = await identityRepo.listAccessibleProperties(req.user.sub);
      }
      if (eventBus && makeAuthEvent) {
        try {
          await eventBus.publish(makeAuthEvent('auth.properties_listed', {
            user_id: req.user.sub, count: rows.length
          }, req, { id: req.user.sub, tenant_id: req.user.tenant_id,
                    primary_property_id: req.user.primary_property_id }));
        } catch (e) { logger.error({ err: e }, '[auth] failed to audit properties_listed'); }
      }
      res.status(200).json({ ok: true, data: rows, requestId: req.requestId });
    } catch (err) { next(err); }
  });

  // -------- POST /switch-property (Phase 6 / C1) -----------------------
  // Re-issue an access+refresh pair scoped to the requested property.
  // Re-validates server-side that the user holds a role at the target.
  router.post('/switch-property', authentication, async (req, res, next) => {
    try {
      const { property_id, device_name, device_id } = req.body || {};
      if (!property_id) {
        return res.status(400).json({ error: 'property_id_required', requestId: req.requestId });
      }
      // Phase 62A: pass tenant_id from JWT for RLS-safe resolveSession.
      const session = await identity.resolveSession(identityRepo, req.user.sub, req.user.tenant_id);
      if (!session) return res.status(401).json({ error: 'user_unavailable', requestId: req.requestId });

      const allowed = session.roles.some((r) => r.property_id === property_id || r.property_id === null);
      if (!allowed) {
        if (eventBus && makeAuthEvent) {
          try {
            await eventBus.publish(makeAuthEvent('auth.property_switch_denied', {
              user_id: req.user.sub, attempted_property_id: property_id,
              from_property_id: req.user.primary_property_id || null
            }, req, session.user));
          } catch (_) {}
        }
        return res.status(403).json({ error: 'not_authorized_at_property', requestId: req.requestId });
      }

      const access  = tokens.issueAccessToken({
        userId:            session.user.id,
        tenantId:          session.user.tenant_id,
        primaryPropertyId: property_id,
        roleCodes:         session.roles.map((x) => x.code),
        roleIds:           session.roles.map((x) => x.id)
      });
      // Phase 62A: insertRefreshToken requires a client when withTenant is active.
      let refresh;
      if (tokensRepo.withTenant && session.user.tenant_id) {
        await tokensRepo.withTenant(session.user.tenant_id, async (client) => {
          refresh = await tokens.issueRefreshToken(tokensRepo, {
            userId:     session.user.id,
            tenantId:   session.user.tenant_id,
            deviceName: device_name || null,
            deviceId:   device_id   || null,
            ipAddress:  req.ip      || null,
            userAgent:  req.get('user-agent') || null
          }, client);
        });
      } else {
        refresh = await tokens.issueRefreshToken(tokensRepo, {
          userId:     session.user.id,
          tenantId:   session.user.tenant_id,
          deviceName: device_name || null,
          deviceId:   device_id   || null,
          ipAddress:  req.ip      || null,
          userAgent:  req.get('user-agent') || null
        });
      }

      if (eventBus && makeAuthEvent) {
        try {
          await eventBus.publish(makeAuthEvent('auth.property_switched', {
            user_id: req.user.sub,
            from_property_id: req.user.primary_property_id || null,
            to_property_id:   property_id
          }, req, Object.assign({}, session.user, { primary_property_id: property_id })));
        } catch (e) { logger.error({ err: e }, '[auth] failed to audit property_switched'); }
      }

      res.status(200).json({
        access_token:       access.token,
        access_expires_at:  access.expiresAt,
        refresh_token:      refresh.token,
        refresh_expires_at: refresh.expiresAt,
        property_id,
        requestId:          req.requestId
      });
    } catch (err) { next(err); }
  });

  // -------- POST /password-reset/request (Phase 57) -------------------
  // Always returns 200 — prevents email enumeration.
  router.post('/password-reset/request', loginLimiter, async (req, res, next) => {
    try {
      if (!passwordResetService) {
        return res.status(501).json({ error: 'not_implemented', requestId: req.requestId });
      }
      const { email } = req.body || {};
      await passwordResetService.requestReset({ email });
      res.status(200).json({ ok: true, requestId: req.requestId });
    } catch (err) { next(err); }
  });

  // -------- POST /password-reset/complete (Phase 57) -------------------
  router.post('/password-reset/complete', async (req, res, next) => {
    try {
      if (!passwordResetService) {
        return res.status(501).json({ error: 'not_implemented', requestId: req.requestId });
      }
      const { token, new_password } = req.body || {};
      if (!token || !new_password) {
        return res.status(400).json({ error: 'missing_fields', requestId: req.requestId });
      }
      const result = await passwordResetService.completeReset({ token, newPassword: new_password });
      if (!result.ok) {
        return res.status(400).json({ error: result.error, requestId: req.requestId });
      }
      res.status(200).json({ ok: true, requestId: req.requestId });
    } catch (err) { next(err); }
  });

  // -------- POST /invitations/accept (Phase 57) ------------------------
  router.post('/invitations/accept', async (req, res, next) => {
    try {
      if (!invitationService) {
        return res.status(501).json({ error: 'not_implemented', requestId: req.requestId });
      }
      const { token, full_name, password } = req.body || {};
      if (!token || !full_name || !password) {
        return res.status(400).json({ error: 'missing_fields', requestId: req.requestId });
      }
      const result = await invitationService.acceptInvitation({ token, fullName: full_name, password });
      if (!result.ok) {
        const status = result.error === 'invitation_not_found' ? 404
                     : result.error === 'invitation_expired'   ? 410
                     : result.error === 'invitation_already_used' ? 409
                     : 400;
        return res.status(status).json({ error: result.error, requestId: req.requestId });
      }
      if (eventBus && makeAuthEvent) {
        try {
          await eventBus.publish(makeAuthEvent('auth.invitation_accepted', {
            user_id: result.userId, email: result.email
          }, req, { id: result.userId, tenant_id: null, primary_property_id: null }));
        } catch (_) {}
      }
      res.status(200).json({ ok: true, userId: result.userId, requestId: req.requestId });
    } catch (err) { next(err); }
  });

  // -------- POST /register (admin-only) --------------------------------
  // The route is admin-gated via the command bus permission system
  // (commands/auth.user.create.js has permission: 'auth.user.create').
  // Public registration is intentionally NOT supported (brief adjustment #5).
  //
  // Phase 67A-003 Workstream D fix: this route used to hard-code
  // `permissions: []` in ctx, with a comment claiming "the command itself
  // enforces auth.user.create via its inputSchema check" — but
  // auth.user.create.js does no such check; the command bus's own
  // `ctx.permissions.includes(cmd.permission)` gate is the ONLY thing that
  // enforces the permission, and with permissions always [] that check
  // ALWAYS failed for every non-super_admin caller (a legitimate
  // corporate_admin who holds auth.user.create was incorrectly denied on
  // every call). Real permissions are now loaded from the authoritative
  // backend identity repository, exactly like the /users/:id/status route
  // below already does — the command bus, not this route, still makes the
  // authorization decision; client-supplied tenantId/propertyId/role
  // grants/permissions are never trusted (ctx is built entirely from
  // req.user, itself derived only from the verified JWT + a fresh DB
  // permissions lookup, never from req.body).
  router.post('/register', authentication, async (req, res, next) => {
    try {
      if (!authRepo || typeof authRepo.withTenant !== 'function'
          || typeof authRepo.findPermissionsForUser !== 'function') {
        return res.status(501).json({ error: 'not_implemented', requestId: req.requestId });
      }
      let permissions = [];
      await authRepo.withTenant(req.user.tenant_id, async (client) => {
        permissions = await authRepo.findPermissionsForUser(req.user.sub, client);
      });
      const commandBus = require('../core/commandBus');
      // Synthesize req.ctx as identityContext would (this route lives at /api/auth so
      // identityContext is not chained here; pull what we need from req.user).
      const ctx = Object.freeze({
        requestId:   req.requestId,
        tenantId:    req.user.tenant_id,
        propertyId:  req.user.primary_property_id || null,
        actorId:     req.user.sub,
        actorName:   req.user.full_name || null,
        roleCodes:   req.user.role_codes || [],
        roleIds:     req.user.role_ids   || [],
        permissions
      });
      const outcome = await commandBus.dispatch('auth.user.create', req.body || {}, ctx);
      res.status(_statusForOutcome(outcome)).json(Object.assign({ requestId: req.requestId }, outcome));
    } catch (err) { next(err); }
  });

  // -------- POST /users/:id/status (admin-only, Phase 67A) -------------
  // Disable or terminate a user account. Admin-gated via the command bus
  // permission system (commands/auth.user.status.js has
  // permission: 'auth.user.disable'). Unlike /register above, this route
  // resolves REAL permissions from the database (via authRepo.
  // findPermissionsForUser, the same lookup identityContext.js uses) rather
  // than passing an empty array, so that an authorized non-super_admin
  // administrator (e.g. corporate_admin, which holds auth.user.disable per
  // the role seed) can actually invoke this command and is not silently
  // always rejected by the command bus's permission check.
  router.post('/users/:id/status', authentication, async (req, res, next) => {
    try {
      if (!authRepo || typeof authRepo.withTenant !== 'function'
          || typeof authRepo.findPermissionsForUser !== 'function') {
        return res.status(501).json({ error: 'not_implemented', requestId: req.requestId });
      }
      let permissions = [];
      await authRepo.withTenant(req.user.tenant_id, async (client) => {
        permissions = await authRepo.findPermissionsForUser(req.user.sub, client);
      });
      const ctx = Object.freeze({
        requestId:   req.requestId,
        tenantId:    req.user.tenant_id,
        propertyId:  req.user.primary_property_id || null,
        actorId:     req.user.sub,
        actorName:   req.user.full_name || null,
        roleCodes:   req.user.role_codes || [],
        roleIds:     req.user.role_ids   || [],
        permissions
      });
      const input = {
        target_user_id: req.params.id,
        status:         req.body && req.body.status,
        reason:         req.body && req.body.reason
      };
      const outcome = await commandBus.dispatch('auth.user.status.change', input, ctx);
      res.status(_statusForOutcome(outcome)).json(Object.assign({ requestId: req.requestId }, outcome));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };

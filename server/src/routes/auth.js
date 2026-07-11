'use strict';

const express     = require('express');
const rateLimit   = require('express-rate-limit');

const identity = require('../services/identity');
const tokens   = require('../services/tokens');
const logger   = require('../config/logger');

const { authentication } = require('../middleware/authentication');

/**
 * Auth router. Routes here are PUBLIC (no authentication required) except:
 *   - GET  /me        - bearer required
 *   - POST /logout    - bearer required
 *   - POST /register  - bearer + permission `auth.user.create` required
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
      const useEmailPath = email && !username && !tenant_code && !property_code;
      if (!useEmailPath) {
        if (!username || !password) {
          return res.status(400).json({ error: 'missing_fields', requestId: req.requestId });
        }
        if ((tenant_code && property_code) || (!tenant_code && !property_code)) {
          return res.status(400).json({ error: 'invalid_login_identifiers', requestId: req.requestId,
                                         detail: 'Provide exactly one of: tenant_code, property_code.' });
        }
      } else if (!password) {
        return res.status(400).json({ error: 'missing_fields', requestId: req.requestId });
      }
      const result = await identity.attemptLogin(identityRepo,
        { tenantCode: tenant_code, propertyCode: property_code, username, email, password });
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

      const access  = tokens.issueAccessToken({
        userId:           result.user.id,
        tenantId:         result.user.tenant_id,
        primaryPropertyId: result.user.primary_property_id,
        roleCodes:        result.roles.map((r) => r.code),
        roleIds:          result.roles.map((r) => r.id)
      });
      const refresh = await tokens.issueRefreshToken(tokensRepo, {
        userId:     result.user.id,
        tenantId:   result.user.tenant_id,
        deviceName: device_name || null,
        deviceId:   device_id   || null,
        ipAddress:  req.ip      || null,
        userAgent:  req.get('user-agent') || null
      });

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
      const session = await identity.resolveSession(identityRepo, r.userId);
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
      const session = await identity.resolveSession(identityRepo, req.user.sub);
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
      const rows = await identityRepo.listAccessibleProperties(req.user.sub);
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
      const session = await identity.resolveSession(identityRepo, req.user.sub);
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
      const refresh = await tokens.issueRefreshToken(tokensRepo, {
        userId:     session.user.id,
        tenantId:   session.user.tenant_id,
        deviceName: device_name || null,
        deviceId:   device_id   || null,
        ipAddress:  req.ip      || null,
        userAgent:  req.get('user-agent') || null
      });

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
      const result = await passwordResetService.requestReset({ email });
      // result.rawToken is available here for delivery — in a later phase this
      // triggers a notification. For now we log that a reset was queued (no token logged).
      if (result.queued && eventBus && makeAuthEvent) {
        try {
          await eventBus.publish(makeAuthEvent('auth.password_reset_requested', {
            user_id: result.userId
          }, req, { id: result.userId, tenant_id: null, primary_property_id: null }));
        } catch (_) {}
      }
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
  router.post('/register', authentication, async (req, res, next) => {
    try {
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
        permissions: [] // command itself enforces 'auth.user.create' via its inputSchema check
      });
      const outcome = await commandBus.dispatch('auth.user.create', req.body || {}, ctx);
      res.status(outcome.ok ? 200 : 400).json(Object.assign({ requestId: req.requestId }, outcome));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };

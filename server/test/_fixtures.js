'use strict';

/**
 * Shared test fixtures: in-memory repos + helpers for issuing test JWTs.
 *
 * Put env sentinels BEFORE requiring the app modules.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.LOG_LEVEL    = 'silent';
process.env.NODE_ENV     = 'test';

const tokens = require('../src/services/tokens');

const TENANT_A = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-1bbb-bbbb-bbbbbbbbbbbb';
const USER_ID  = 'cccccccc-cccc-1ccc-cccc-cccccccccccc';
const PROP_ID  = 'dddddddd-dddd-1ddd-dddd-dddddddddddd';

function makeFakeDb({ pingResult = true } = {}) {
  const auditRows = [];
  return {
    auditRows,
    pingResult,
    async ping() {
      if (this.pingResult instanceof Error) throw this.pingResult;
      return !!this.pingResult;
    },
    async insertAuditEvent(ev) { auditRows.push(ev); }
  };
}

function makeFakeRepos(overrides = {}) { return _makeFakeReposCore(overrides); }
function _makeFakeReposCore(overrides = {}) {
  const users = new Map();
  const userRoles = new Map();
  const userPerms = new Map();
  const refreshTokens = new Map();
  const propertyDates = new Map();
  const _propertiesById = new Map();   // Phase 6 / C2 + C3 fixture state

  const identityRepo = Object.assign({
    async findUserByTenantUsername(tenantCode, username) {
      for (const u of users.values()) {
        if (u.tenant_code === tenantCode && u.username === username) return u;
      }
      return null;
    },
    async findUserByTenantUsernameById(tenantId, username) {
      for (const u of users.values()) {
        if (u.tenant_id === tenantId && u.username === username) return u;
      }
      return null;
    },
    async findUserById(id) { return users.get(id) || null; },
    async findRolesForUser(uid) { return userRoles.get(uid) || []; },
    async findPermissionsForUser(uid) { return userPerms.get(uid) || []; },
    async updateUserOnSuccessfulLogin() {},
    async updateUserOnFailedLogin() {},
    async insertUser(rec) {
      const id = 'usr_' + (users.size + 1);
      const row = Object.assign({ id }, rec, { tenant_code: 'TENANT-A' });
      users.set(id, row);
      return row;
    },
    async insertUserRoleByCode({ user_id, role_code }) {
      const list = userRoles.get(user_id) || [];
      list.push({ id: 'role-' + role_code, code: role_code, scope: 'TENANT', property_id: null });
      userRoles.set(user_id, list);
    },
    async findPropertyBusinessDate(propertyId) {
      return propertyDates.get(propertyId) || null;
    },

    // Phase 6 / C3: in-memory property-code login resolver.
    async findUserByPropertyCodeUsername(propertyCode, username) {
      for (const u of users.values()) {
        // The test seeder sets `accessible_property_codes` on the user row.
        const codes = u.accessible_property_codes || (u.primary_property_code ? [u.primary_property_code] : []);
        if (codes.includes(propertyCode) && u.username === username) {
          return Object.assign({}, u, {
            resolved_property_id: u.primary_property_id,
            resolved_property_code: propertyCode
          });
        }
      }
      return null;
    },

    // Phase 6 / C2: in-memory list of accessible properties for a user.
    async listAccessibleProperties(userId) {
      const list = userRoles.get(userId) || [];
      const seen = new Map();
      const props = _propertiesById;       // closed-over, not via `this`
      for (const r of list) {
        if (r.property_id && props.has(r.property_id)) {
          const p = props.get(r.property_id);
          if (!seen.has(p.id)) seen.set(p.id, Object.assign({}, p, { role_codes: [] }));
          seen.get(p.id).role_codes.push(r.code);
        }
      }
      const user = users.get(userId);
      if (user && user.primary_property_id && props.has(user.primary_property_id) && !seen.has(user.primary_property_id)) {
        seen.set(user.primary_property_id, Object.assign({}, props.get(user.primary_property_id), { role_codes: [] }));
      }
      return Array.from(seen.values()).sort((a, b) => a.code.localeCompare(b.code));
    },
    _seedAccessibleProperty(p) { _propertiesById.set(p.id, p); },

    // Test helpers
    _seedUser(user, roles = [], perms = []) {
      users.set(user.id, user);
      userRoles.set(user.id, roles);
      userPerms.set(user.id, perms);
    },
    _seedPropertyDate(propertyId, date, locked = false) {
      propertyDates.set(propertyId, { current_business_date: date, business_date_locked: locked });
    },
    _users: users
  }, overrides.identityRepo || {});

  const tokensRepo = Object.assign({
    async insertRefreshToken(rec) {
      const row = Object.assign({ id: 'rt_' + (refreshTokens.size + 1) }, rec);
      refreshTokens.set(row.token_hash, row);
      return row;
    },
    async findRefreshTokenByHash(hash) { return refreshTokens.get(hash) || null; },
    async markRefreshTokenUsed(id, ts) {
      for (const r of refreshTokens.values()) if (r.id === id) r.last_used_at = ts;
    },
    async revokeRefreshToken(id, ts) {
      for (const r of refreshTokens.values()) if (r.id === id) r.revoked_at = ts;
    },
    async revokeChainFrom(id, ts) {
      for (const r of refreshTokens.values()) if (r.id === id) r.revoked_at = ts;
    },
    async linkRotation(oldId, newId) {
      for (const r of refreshTokens.values()) if (r.id === oldId) r.rotated_to = newId;
    },
    _refreshTokens: refreshTokens
  }, overrides.tokensRepo || {});

  // ---------- Phase 3 in-memory repos ----------
  const _phase3 = _makePhase3Repos();

  return Object.assign(
    { identityRepo, tokensRepo, _store: { users, userRoles, userPerms, refreshTokens } },
    _phase3
  );
}

function _makePhase3Repos() {
  // settings
  const settings = []; // {tenant_id, property_id, category, key, value_json, updated_by, updated_at}
  const settingsRepo = {
    async findSetting(tenantId, propertyId, category, key) {
      return settings.find(s =>
        s.tenant_id === tenantId &&
        ((propertyId == null && s.property_id == null) || s.property_id === propertyId) &&
        s.category === category && s.key === key) || null;
    },
    async upsertSetting(rec) {
      const idx = settings.findIndex(s =>
        s.tenant_id === rec.tenant_id &&
        ((rec.property_id == null && s.property_id == null) || s.property_id === rec.property_id) &&
        s.category === rec.category && s.key === rec.key);
      const row = Object.assign({}, rec, { updated_at: new Date().toISOString() });
      if (idx >= 0) settings[idx] = row; else settings.push(row);
      return row;
    },
    async listSettings(tenantId, category) {
      return settings.filter(s => s.tenant_id === tenantId && (!category || s.category === category));
    },
    async deleteSetting(tenantId, propertyId, category, key) {
      const before = settings.length;
      for (let i = settings.length - 1; i >= 0; i--) {
        const s = settings[i];
        if (s.tenant_id === tenantId &&
            ((propertyId == null && s.property_id == null) || s.property_id === propertyId) &&
            s.category === category && s.key === key) settings.splice(i, 1);
      }
      return before - settings.length;
    },
    _settings: settings
  };

  // files
  const filesArr = [];
  const fileRepo = {
    async insertFile(rec) {
      const row = Object.assign({ id: 'file_' + (filesArr.length + 1), status: 'available', uploaded_at: new Date().toISOString() }, rec);
      filesArr.push(row);
      return row;
    },
    async findFileById(tenantId, id) { return filesArr.find(f => f.tenant_id === tenantId && f.id === id) || null; },
    async softDeleteFile(tenantId, id) {
      const f = filesArr.find(x => x.tenant_id === tenantId && x.id === id);
      if (!f) return false;
      f.status = 'deleted'; f.deleted_at = new Date().toISOString();
      return true;
    },
    _files: filesArr
  };

  // connectors
  const connectors = [
    { id:'c-stripe',      code:'stripe',      label:'Stripe',           type:'payment_gateway',   is_active:true },
    { id:'c-anthropic',   code:'anthropic',   label:'Anthropic Claude', type:'ai_provider',       is_active:true },
    { id:'c-booking_com', code:'booking_com', label:'Booking.com',      type:'channel_manager',   is_active:true }
  ];
  const connectorConfigs = [];
  const healthLog = [];
  const connectorRepo = {
    async listConnectors() { return connectors.slice(); },
    async findConnectorByCode(code) { return connectors.find(c => c.code === code) || null; },
    async findConnectorConfig(tenantId, propertyId, code) {
      const c = connectors.find(x => x.code === code); if (!c) return null;
      return connectorConfigs.find(cc => cc.tenant_id === tenantId && cc.connector_id === c.id &&
        ((propertyId == null && cc.property_id == null) || cc.property_id === propertyId)) || null;
    },
    async upsertConnectorConfig(rec) {
      const idx = connectorConfigs.findIndex(cc => cc.tenant_id === rec.tenant_id && cc.connector_id === rec.connector_id &&
        ((rec.property_id == null && cc.property_id == null) || cc.property_id === rec.property_id));
      const row = Object.assign({}, rec);
      if (idx >= 0) connectorConfigs[idx] = row; else connectorConfigs.push(row);
      return row;
    },
    async insertConnectorHealthLog(rec) { healthLog.push(Object.assign({ occurred_at: new Date().toISOString() }, rec)); },
    _healthLog: healthLog,
    _connectorConfigs: connectorConfigs,
    _connectors: connectors
  };

  // scheduler
  const jobs = [];
  const schedulerRepo = {
    async insertScheduledJob(rec) {
      const row = Object.assign({ id: 'job_' + (jobs.length+1), status:'pending', attempts:0, locked_by:null }, rec);
      jobs.push(row);
      return row;
    },
    async cancelScheduledJob(id) {
      const j = jobs.find(x => x.id === id);
      if (!j || j.status !== 'pending') return false;
      j.status = 'cancelled';
      return true;
    },
    async claimDueJobs({ workerId, limit }) {
      const now = Date.now();
      const due = jobs.filter(j => j.status === 'pending' && new Date(j.run_at).getTime() <= now).slice(0, limit);
      due.forEach(j => { j.status = 'running'; j.locked_by = workerId; j.locked_at = new Date().toISOString(); j.attempts += 1; j.started_at = new Date().toISOString(); });
      return due;
    },
    async markJobCompleted(id) {
      const j = jobs.find(x => x.id === id); if (j) { j.status = 'completed'; j.completed_at = new Date().toISOString(); }
    },
    async markJobCompletedAndReschedule(id, nextRunAt) {
      const j = jobs.find(x => x.id === id);
      if (!j) return;
      j.status = 'pending';
      j.run_at = nextRunAt;
      j.next_run_at = nextRunAt;
      j.attempts = 0;
      j.last_error = null;
      j.locked_by = null; j.locked_at = null;
      j.started_at = null; j.completed_at = null;
    },
    async markJobFailed(id, error, final, finalState) {
      const j = jobs.find(x => x.id === id);
      if (!j) return;
      j.last_error = error;
      j.status = final ? (finalState || 'failed') : 'pending';
      if (j.status === 'dead_letter') j.dead_letter_reason = error;
      j.locked_by = null; j.locked_at = null;
      if (final) j.completed_at = new Date().toISOString();
    },
    _jobs: jobs
  };

  // notifications
  const notifications = [];
  const templates = [];
  const deliveryLog = [];
  const notificationRepo = {
    async findActiveTemplate(tenantId, code, channel) {
      return templates.find(t => t.tenant_id === tenantId && t.code === code && t.channel === channel && t.is_active !== false) || null;
    },
    async insertNotification(rec) {
      const row = Object.assign({ id: 'notif_' + (notifications.length + 1), requested_at: new Date().toISOString() }, rec);
      notifications.push(row);
      return row;
    },
    async findNotificationById(tenantId, id) {
      const n = notifications.find(x => x.tenant_id === tenantId && x.id === id);
      if (!n) return null;
      return Object.assign({}, n, { delivery_log: deliveryLog.filter(d => d.notification_id === id) });
    },
    async listNotifications(tenantId, status, limit) {
      return notifications.filter(n => n.tenant_id === tenantId && (!status || n.status === status)).slice(0, limit || 100);
    },
    async claimPendingNotifications({ limit }) {
      const claimed = notifications.filter(n => n.status === 'pending').slice(0, limit);
      claimed.forEach(n => { n.status = 'sending'; });
      return claimed;
    },
    async markNotificationStatus(id, status) {
      const n = notifications.find(x => x.id === id);
      if (n) { n.status = status; if (['delivered','failed','not_configured','cancelled'].includes(status)) n.completed_at = new Date().toISOString(); }
    },
    async insertDeliveryLog(rec) {
      deliveryLog.push(Object.assign({ attempted_at: new Date().toISOString() }, rec));
    },
    async nextAttemptNo(notificationId) {
      const max = deliveryLog.filter(d => d.notification_id === notificationId).reduce((m, d) => Math.max(m, d.attempt_no || 0), 0);
      return max + 1;
    },
    _notifications: notifications, _templates: templates, _deliveryLog: deliveryLog,
    _seedTemplate(t) { templates.push(t); }
  };

  // webhooks
  const endpoints = [];
  const deliveries = [];
  const webhookRepo = {
    async insertWebhookEndpoint(rec) {
      const row = Object.assign({ id: 'wh_' + (endpoints.length + 1), is_active: true, created_at: new Date().toISOString() }, rec);
      endpoints.push(row);
      return row;
    },
    async listWebhookEndpoints(tenantId) { return endpoints.filter(e => e.tenant_id === tenantId); },
    async disableWebhookEndpoint(tenantId, id) {
      const e = endpoints.find(x => x.tenant_id === tenantId && x.id === id && x.is_active);
      if (!e) return false;
      e.is_active = false; e.disabled_at = new Date().toISOString();
      return true;
    },
    async findWebhookEndpoint(id) { return endpoints.find(e => e.id === id) || null; },
    async listActiveEndpointsForEvent(tenantId, eventType) {
      return endpoints.filter(e => e.tenant_id === tenantId && e.is_active &&
        ((e.event_types || []).length === 0 || (e.event_types || []).includes(eventType)));
    },
    async insertWebhookDelivery(rec) {
      const row = Object.assign({ id: 'wd_' + (deliveries.length + 1), status: 'pending', attempts: 0, max_attempts: 5, next_attempt_at: new Date().toISOString() }, rec);
      deliveries.push(row);
      return row;
    },
    async claimDueWebhookDeliveries({ limit }) {
      const now = Date.now();
      const claimed = deliveries.filter(d => ['pending','failed'].includes(d.status) && new Date(d.next_attempt_at).getTime() <= now && d.attempts < d.max_attempts).slice(0, limit);
      claimed.forEach(d => { d.status = 'sending'; d.attempts += 1; });
      return claimed;
    },
    async markWebhookDelivered(id, statusCode) {
      const d = deliveries.find(x => x.id === id); if (d) { d.status = 'delivered'; d.last_status_code = statusCode; d.delivered_at = new Date().toISOString(); }
    },
    async markWebhookFailed(id, error, statusCode, nextAttemptAt, final) {
      const d = deliveries.find(x => x.id === id); if (!d) return;
      d.last_error = error; d.last_status_code = statusCode;
      if (nextAttemptAt) d.next_attempt_at = nextAttemptAt;
      d.status = final ? 'failed' : 'pending';
    },
    _endpoints: endpoints, _deliveries: deliveries
  };

  // ----- PMS in-memory repo (Phase 5) -----
  const pms = _makePmsMemoryRepo();
  // ----- Phase 5.5 in-memory repos -----
  const folio = _makeFolioMemoryRepo();
  const hk    = _makeHousekeepingMemoryRepo();
  const na    = _makeNightAuditMemoryRepo(pms);
  // ----- Phase 8 in-memory repos -----
  const cc    = _makeCostCenterMemoryRepo();
  const rm    = _makeRevenueMapMemoryRepo();
  const led   = _makeLedgerMemoryRepo();
  return { settingsRepo, fileRepo, connectorRepo, schedulerRepo, notificationRepo, webhookRepo,
           pmsRepo: pms, folioRepo: folio, housekeepingRepo: hk, nightAuditRepo: na,
           costCenterRepo: cc, revenueMapRepo: rm, ledgerRepo: led };
}

function _makePmsMemoryRepo() {
  const _id = (() => { let n = 0; return (p) => p + '_' + (++n); })();
  const buildings = [], floors = [], roomTypes = [], rooms = [], features = [], roomFeatures = [];
  const guests = [], policies = [], categories = [];
  const counters = new Map(); // (property_id|year) -> next
  const reservations = [], ratePlans = [], ratePlanPeriods = [], ratePlanPricing = [];
  const properties = [];
  const mealPlans = [];

  return {
    _store: { buildings, floors, roomTypes, rooms, features, guests, policies, categories, reservations, ratePlans, properties },
    _seedProperty(p) { properties.push(p); },

    async insertBuilding(rec) { const r = Object.assign({ id: _id('b'), created_at: new Date().toISOString() }, rec); buildings.push(r); return r; },
    async listBuildings(t, p) { return buildings.filter(b => b.tenant_id===t && b.property_id===p); },
    async insertFloor(rec)    { const r = Object.assign({ id: _id('f'), created_at: new Date().toISOString() }, rec); floors.push(r); return r; },
    async listFloors(t, b)    { return floors.filter(x => x.tenant_id===t && x.building_id===b); },

    async insertRoomType(rec) { const r = Object.assign({ id: _id('rt') }, rec); roomTypes.push(r); return r; },
    async findRoomTypeById(t, id) { return roomTypes.find(x => x.tenant_id===t && x.id===id) || null; },
    async findRoomTypeByCode(t, p, code) { return roomTypes.find(x => x.tenant_id===t && x.property_id===p && x.code===code) || null; },
    async listRoomTypes(t, p) { return roomTypes.filter(x => x.tenant_id===t && x.property_id===p); },

    async insertRoom(rec) { const r = Object.assign({ id: _id('r'), updated_at: new Date().toISOString() }, rec); rooms.push(r); return r; },
    async findRoomById(t, id) { return rooms.find(x => x.tenant_id===t && x.id===id) || null; },
    async findRoomByNumber(t, p, num) { return rooms.find(x => x.tenant_id===t && x.property_id===p && x.room_number===num) || null; },
    async listRooms(t, p, opts = {}) {
      let xs = rooms.filter(x => x.tenant_id===t && x.property_id===p);
      if (opts.activeOnly) xs = xs.filter(x => x.active);
      // emulate join to add room_type_code
      return xs.map(r => Object.assign({}, r, { room_type_code: (roomTypes.find(rt => rt.id===r.room_type_id)||{}).code }));
    },
    async listRoomsForAvailability({ tenantId, propertyId, roomTypeId }) {
      let xs = rooms.filter(x => x.tenant_id===tenantId && x.property_id===propertyId);
      if (roomTypeId) xs = xs.filter(x => x.room_type_id === roomTypeId);
      return xs.map(r => Object.assign({}, r, { room_type_code: (roomTypes.find(rt => rt.id===r.room_type_id)||{}).code }));
    },
    async updateRoomStatus(t, id, status) { const r = rooms.find(x => x.tenant_id===t && x.id===id); if (!r) return null; r.status = status; r.updated_at = new Date().toISOString(); return r; },
    async setRoomActive(t, id, active) { const r = rooms.find(x => x.tenant_id===t && x.id===id); if (!r) return null; r.active = active; r.updated_at = new Date().toISOString(); return r; },

    async insertRoomFeature(rec) { const r = Object.assign({ id: _id('ft') }, rec); features.push(r); return r; },
    async listRoomFeatures(t, p) { return features.filter(x => x.tenant_id===t && x.property_id===p); },
    async attachRoomFeature(t, roomId, featureId) {
      if (!roomFeatures.find(x => x.room_id===roomId && x.feature_id===featureId)) roomFeatures.push({ room_id: roomId, feature_id: featureId, tenant_id: t });
    },
    async listFeaturesForRoom(t, roomId) {
      const ids = roomFeatures.filter(x => x.tenant_id===t && x.room_id===roomId).map(x => x.feature_id);
      return features.filter(f => ids.includes(f.id));
    },

    async insertGuest(rec) { const r = Object.assign({ id: _id('g'), updated_at: new Date().toISOString(), created_at: new Date().toISOString() }, rec); guests.push(r); return r; },
    async findGuestById(t, id) { return guests.find(x => x.tenant_id===t && x.id===id) || null; },
    async listGuests(t, opts = {}) {
      let xs = guests.filter(x => x.tenant_id===t);
      if (opts.guestType) xs = xs.filter(x => x.guest_type === opts.guestType);
      if (opts.q) {
        const q = String(opts.q).toLowerCase();
        xs = xs.filter(x => [x.first_name, x.last_name, x.email, x.mobile, x.organization_name].some(v => v && String(v).toLowerCase().includes(q)));
      }
      return xs;
    },
    async updateGuestFlags(t, id, { vip_flag, blacklisted_flag }) {
      const r = guests.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      if (vip_flag         !== null && vip_flag         !== undefined) r.vip_flag = vip_flag;
      if (blacklisted_flag !== null && blacklisted_flag !== undefined) r.blacklisted_flag = blacklisted_flag;
      r.updated_at = new Date().toISOString();
      return r;
    },

    async insertChildPolicy(rec) { const r = Object.assign({ id: _id('cp') }, rec); policies.push(r); return r; },
    async insertChildAgeCategory(rec) { const r = Object.assign({ id: _id('cc') }, rec); categories.push(r); return r; },
    async loadChildPolicyWithCategories(t, id) {
      const p = policies.find(x => x.tenant_id===t && x.id===id);
      if (!p) return null;
      return Object.assign({}, p, { categories: categories.filter(c => c.tenant_id===t && c.child_policy_id===id) });
    },
    async listChildPolicies(t, p) { return policies.filter(x => x.tenant_id===t && x.property_id===p); },

    async bumpReservationCounter({ tenantId, propertyId, year }) {
      const k = propertyId + '|' + year;
      const v = counters.get(k) || 1;
      counters.set(k, v + 1);
      return v;
    },
    async insertReservation(rec) {
      const r = Object.assign({ id: _id('res'), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, rec);
      const a = Date.parse(rec.arrival_date); const d = Date.parse(rec.departure_date);
      r.nights = Math.round((d - a) / 86400000);
      reservations.push(r); return r;
    },

    // Phase 7 / C5 - reservation groups (in-memory)
    async insertReservationGroup(rec) {
      this._groups = this._groups || [];
      const r = Object.assign({ id: _id('grp'), total_rooms: rec.total_rooms || 0, total_guests: rec.total_guests || 0,
                                 created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, rec);
      this._groups.push(r); return r;
    },
    async findReservationGroupById(t, id) {
      return (this._groups || []).find((x) => x.tenant_id === t && x.id === id) || null;
    },
    async listReservationsInGroup(t, gid) {
      return reservations.filter((r) => r.tenant_id === t && r.group_id === gid)
        .map((r) => Object.assign({}, r, { room_type_code: (roomTypes.find((rt) => rt.id === r.room_type_id) || {}).code }));
    },
    async attachReservationToGroup(t, resId, gid) {
      const r = reservations.find((x) => x.tenant_id === t && x.id === resId);
      if (!r) return null;
      r.group_id = gid; r.updated_at = new Date().toISOString();
      return r;
    },
    async bumpGroupTotals(t, gid, { roomsDelta = 0, guestsDelta = 0 }) {
      const g = (this._groups || []).find((x) => x.tenant_id === t && x.id === gid);
      if (!g) return null;
      g.total_rooms = (g.total_rooms || 0) + roomsDelta;
      g.total_guests = (g.total_guests || 0) + guestsDelta;
      g.updated_at = new Date().toISOString();
      return g;
    },

    // Phase 7 / C6 - vouchers (in-memory)
    async insertVoucher(rec) {
      this._vouchers = this._vouchers || [];
      if (this._vouchers.find((v) => v.property_id === rec.property_id && v.voucher_number === rec.voucher_number)) {
        const e = new Error('duplicate voucher_number'); e.code = '23505'; throw e;
      }
      const r = Object.assign({ id: _id('v'), status: rec.status || 'ISSUED',
                                 issued_at: new Date().toISOString() }, rec);
      this._vouchers.push(r); return r;
    },
    async findVoucherById(t, id) {
      return (this._vouchers || []).find((x) => x.tenant_id === t && x.id === id) || null;
    },
    async findVoucherByNumber(t, p, n) {
      return (this._vouchers || []).find((x) => x.tenant_id === t && x.property_id === p && x.voucher_number === n) || null;
    },
    async redeemVoucher(t, id, reservationId) {
      const v = (this._vouchers || []).find((x) => x.tenant_id === t && x.id === id);
      if (!v || v.status !== 'ISSUED') return null;
      v.status = 'REDEEMED'; v.redeemed_at = new Date().toISOString();
      v.redeemed_reservation_id = reservationId;
      return v;
    },
    async cancelVoucher(t, id, reason) {
      const v = (this._vouchers || []).find((x) => x.tenant_id === t && x.id === id);
      if (!v || v.status !== 'ISSUED') return null;
      v.status = 'CANCELLED'; v.cancelled_at = new Date().toISOString();
      v.cancellation_reason = reason;
      return v;
    },

    // Phase 7 / C7 - allocation lifecycle (in-memory)
    async insertAllocation(rec) {
      this._allocations = this._allocations || [];
      const r = Object.assign({ id: _id('alloc'), qty_consumed: 0, status: rec.status || 'ACTIVE',
                                created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, rec);
      this._allocations.push(r); return r;
    },
    async findAllocationById(t, id) {
      return (this._allocations || []).find((x) => x.tenant_id === t && x.id === id) || null;
    },
    async consumeAllocation(t, id, qty) {
      const a = (this._allocations || []).find((x) => x.tenant_id === t && x.id === id);
      if (!a || a.status !== 'ACTIVE') return null;
      if ((a.qty_consumed + qty) > a.qty_blocked) return null;
      a.qty_consumed += qty;
      if (a.qty_consumed >= a.qty_blocked) a.status = 'EXHAUSTED';
      a.updated_at = new Date().toISOString();
      return a;
    },
    async decrementAllocationConsumption(t, id, qty) {
      const a = (this._allocations || []).find((x) => x.tenant_id === t && x.id === id);
      if (!a) return null;
      a.qty_consumed = Math.max(0, a.qty_consumed - qty);
      if (a.status === 'EXHAUSTED') a.status = 'ACTIVE';
      a.updated_at = new Date().toISOString();
      return a;
    },
    async releaseAllocation(t, id) {
      const a = (this._allocations || []).find((x) => x.tenant_id === t && x.id === id);
      if (!a || a.status !== 'ACTIVE') return null;
      a.status = 'RELEASED';
      a.updated_at = new Date().toISOString();
      return a;
    },
    async listAllocationsDueForRelease(asOfDate) {
      return (this._allocations || []).filter((a) => {
        if (a.status !== 'ACTIVE') return false;
        const release = new Date(a.date_from);
        release.setUTCDate(release.getUTCDate() - (a.release_days || 0));
        return release.toISOString().slice(0, 10) <= asOfDate;
      });
    },
    async findReservationById(t, id) { return reservations.find(x => x.tenant_id===t && x.id===id) || null; },
    async findReservationByNumber(t, p, n) { return reservations.find(x => x.tenant_id===t && x.property_id===p && x.reservation_number===n) || null; },
    async setReservationStatus(t, id, status, { cancellationReason } = {}) {
      const r = reservations.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      r.status = status;
      if (['CANCELLED','NO_SHOW'].includes(status)) r.cancelled_at = new Date().toISOString();
      if (cancellationReason) r.cancellation_reason = cancellationReason;
      r.updated_at = new Date().toISOString();
      return r;
    },
    async listReservations(t, p, opts = {}) {
      let xs = reservations.filter(x => x.tenant_id===t && x.property_id===p);
      if (opts.status)   xs = xs.filter(x => x.status === opts.status);
      if (opts.dateFrom) xs = xs.filter(x => x.arrival_date >= opts.dateFrom);
      if (opts.dateTo)   xs = xs.filter(x => x.arrival_date <= opts.dateTo);
      return xs;
    },
    async listReservationsOverlapping({ tenantId, propertyId, date, statuses, roomTypeId }) {
      return reservations.filter(x =>
        x.tenant_id===tenantId && x.property_id===propertyId &&
        x.arrival_date <= date && x.departure_date > date &&
        statuses.includes(x.status) &&
        (!roomTypeId || x.room_type_id === roomTypeId)
      ).map(x => Object.assign({}, x, { room_type_code: (roomTypes.find(rt => rt.id===x.room_type_id)||{}).code }));
    },
    async listReservationsInRange({ tenantId, propertyId, dateFrom, dateTo, statuses, roomTypeId }) {
      return reservations.filter(x =>
        x.tenant_id===tenantId && x.property_id===propertyId &&
        x.departure_date > dateFrom && x.arrival_date < dateTo &&
        statuses.includes(x.status) &&
        (!roomTypeId || x.room_type_id === roomTypeId)
      ).map(x => Object.assign({}, x, { room_type_code: (roomTypes.find(rt => rt.id===x.room_type_id)||{}).code }));
    },

    async insertRatePlan(rec) { const r = Object.assign({ id: _id('rp') }, rec); ratePlans.push(r); return r; },
    async findRatePlanById(t, id) { return ratePlans.find(x => x.tenant_id===t && x.id===id) || null; },
    async listRatePlans(t, p) { return ratePlans.filter(x => x.tenant_id===t && x.property_id===p); },
    async insertRatePlanPeriod(rec) { const r = Object.assign({ id: _id('rpp') }, rec); ratePlanPeriods.push(r); return r; },
    async insertRatePlanPricing(rec) { const r = Object.assign({ id: _id('rpx') }, rec); ratePlanPricing.push(r); return r; },
    async listRatePlanPeriods(t, id) { return ratePlanPeriods.filter(x => x.tenant_id===t && x.rate_plan_id===id); },
    async listRatePlanPricing(t, id) { return ratePlanPricing.filter(x => x.tenant_id===t && x.rate_plan_id===id); },

    async findPropertyById(t, id) { return properties.find(x => x.tenant_id===t && x.id===id) || null; },
    async listPropertiesWithStaleBusinessDate(thresholdHours) {
      // In tests, _seedProperty sets `_age_hours` directly; we filter on that.
      return properties.filter((p) => p.active !== false
        && p.current_business_date != null
        && (Number(p._age_hours) || 0) > Number(thresholdHours))
        .map((p) => Object.assign({}, p, { age_hours: p._age_hours }));
    },

    // Phase 6 / C4 - meal plans
    async insertMealPlan(rec) {
      if (mealPlans.find((m) => m.property_id === rec.property_id && m.code === rec.code)) {
        const e = new Error('duplicate'); e.code = '23505'; throw e;
      }
      const r = Object.assign({ id: _id('mp'), created_at: new Date().toISOString() }, rec);
      mealPlans.push(r); return r;
    },
    async findMealPlanById(t, id) { return mealPlans.find(x => x.tenant_id===t && x.id===id) || null; },
    async listMealPlans(t, p) { return mealPlans.filter(x => x.tenant_id===t && x.property_id===p); },
    async attachMealPlanToRatePlan(t, rateId, mealId) {
      const rp = ratePlans.find(x => x.tenant_id===t && x.id===rateId);
      if (!rp) return null;
      rp.meal_plan_id = mealId; rp.updated_at = new Date().toISOString();
      return rp;
    },

    // Phase 5.5 check-in/out
    async checkInReservation(t, id, { userId, assignedRoomId }) {
      const r = reservations.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      r.status = 'CHECKED_IN';
      r.checked_in_at = new Date().toISOString();
      r.checked_in_by = userId || null;
      if (assignedRoomId) {
        r.assigned_room_id = assignedRoomId;
        const room = rooms.find(x => x.tenant_id===t && x.id===assignedRoomId);
        if (room) { room.status = 'OCCUPIED'; room.updated_at = new Date().toISOString(); }
      }
      r.updated_at = new Date().toISOString();
      return r;
    },
    async checkOutReservation(t, id, { userId }) {
      const r = reservations.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      r.status = 'CHECKED_OUT';
      r.checked_out_at = new Date().toISOString();
      r.checked_out_by = userId || null;
      r.updated_at = new Date().toISOString();
      if (r.assigned_room_id) {
        const room = rooms.find(x => x.tenant_id===t && x.id===r.assigned_room_id);
        if (room) { room.status = 'VACANT_DIRTY'; room.updated_at = new Date().toISOString(); }
      }
      return r;
    }
  };
}

function _makeFolioMemoryRepo() {
  const _id = (() => { let n = 0; return (p) => p + '_' + (++n); })();
  const folios = [], lines = [], allocations = [], invoices = [];
  const counters = new Map();
  return {
    _store: { folios, lines, allocations, invoices },
    async bumpFolioCounter({ tenantId, propertyId, year }) {
      const k = propertyId + '|' + year;
      const v = counters.get(k) || 1;
      counters.set(k, v + 1);
      return v;
    },
    async insertFolio(rec) {
      const r = Object.assign({
        id: _id('fo'), opened_at: new Date().toISOString(),
        total_charges: 0, total_payments: 0, balance: 0,
        updated_at: new Date().toISOString()
      }, rec);
      folios.push(r); return r;
    },
    async findFolioById(t, id) { return folios.find(x => x.tenant_id===t && x.id===id) || null; },
    async listFoliosForReservation(t, resId) { return folios.filter(x => x.tenant_id===t && x.reservation_id===resId); },
    async insertFolioLine(rec) {
      const r = Object.assign({ id: _id('fl'), posted_at: new Date().toISOString() }, rec);
      lines.push(r);
      const f = folios.find(x => x.id === rec.folio_id);
      if (f) {
        const myLines = lines.filter(l => l.folio_id === f.id);
        f.total_charges  = myLines.filter(l => !['PAYMENT','REFUND'].includes(l.charge_type)).reduce((s, l) => s + Number(l.amount), 0);
        f.total_payments = myLines.filter(l =>  ['PAYMENT','REFUND'].includes(l.charge_type)).reduce((s, l) => s + Number(l.amount), 0);
        f.balance        = myLines.reduce((s, l) => s + Number(l.amount), 0);
        f.updated_at     = new Date().toISOString();
      }
      return r;
    },
    async listFolioLines(t, folioId) { return lines.filter(l => l.tenant_id===t && l.folio_id===folioId); },
    async closeFolio(t, id) {
      const f = folios.find(x => x.tenant_id===t && x.id===id);
      if (!f) return null;
      f.status = 'CLOSED'; f.closed_at = new Date().toISOString(); f.updated_at = new Date().toISOString();
      return f;
    },

    // Phase 7 / C9 - invoices
    async bumpInvoiceCounter({ tenantId, propertyId, year }) {
      const k = 'inv|' + propertyId + '|' + year;
      const v = counters.get(k) || 1;
      counters.set(k, v + 1);
      return v;
    },
    async insertInvoice(rec) {
      const r = Object.assign({ id: _id('inv'), created_at: new Date().toISOString(),
                                 status: rec.status || 'ISSUED' }, rec);
      (this._store.invoices = this._store.invoices || []).push(r);
      return r;
    },
    async findInvoiceById(t, id) {
      return (this._store.invoices || []).find((x) => x.tenant_id === t && x.id === id) || null;
    },
    async findInvoiceByNumber(t, p, n) {
      return (this._store.invoices || []).find((x) => x.tenant_id === t && x.property_id === p && x.invoice_number === n) || null;
    },
    async listInvoices(t, p, opts = {}) {
      return (this._store.invoices || [])
        .filter((x) => x.tenant_id === t && x.property_id === p
          && (!opts.status || x.status === opts.status));
    },
    async voidInvoice(t, id, reason) {
      const inv = (this._store.invoices || []).find((x) => x.tenant_id === t && x.id === id);
      if (!inv || inv.status !== 'ISSUED') return null;
      inv.status = 'VOIDED'; inv.voided_at = new Date().toISOString();
      inv.void_reason = reason; inv.updated_at = new Date().toISOString();
      return inv;
    },

    // Phase 7 / C8 - payment allocations
    async insertPaymentAllocation(rec) {
      const r = Object.assign({ id: _id('pa'), allocated_at: new Date().toISOString() }, rec);
      allocations.push(r); return r;
    },
    async listAllocationsForPayment(t, pid) { return allocations.filter(a => a.tenant_id===t && a.payment_line_id===pid); },
    async listAllocationsForCharge(t, cid)  { return allocations.filter(a => a.tenant_id===t && a.charge_line_id===cid); },
    async listAllocationsForFolio(t, fid)   { return allocations.filter(a => a.tenant_id===t && a.folio_id===fid); },
    async findFolioLineById(t, id) {
      const l = lines.find((x) => x.id === id);
      if (!l) return null;
      const f = folios.find((x) => x.id === l.folio_id);
      return (f && f.tenant_id === t) ? l : null;
    }
  };
}

function _makeHousekeepingMemoryRepo() {
  const _id = (() => { let n = 0; return (p) => p + '_' + (++n); })();
  const tasks = [];
  return {
    _store: { tasks },
    async insertTask(rec) {
      const r = Object.assign({
        id: _id('hk'), status: rec.status || 'PENDING',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }, rec);
      tasks.push(r); return r;
    },
    async findTaskById(t, id) { return tasks.find(x => x.tenant_id===t && x.id===id) || null; },
    async assignTask(t, id, userId) {
      const r = tasks.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      r.status = 'ASSIGNED'; r.assigned_to = userId; r.assigned_at = new Date().toISOString();
      r.updated_at = new Date().toISOString();
      return r;
    },
    async completeTask(t, id, { verifiedBy, notes } = {}) {
      const r = tasks.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      r.status = 'COMPLETED'; r.completed_at = new Date().toISOString();
      if (verifiedBy) { r.verified_by = verifiedBy; r.verified_at = new Date().toISOString(); }
      if (notes) r.notes = notes;
      r.updated_at = new Date().toISOString();
      return r;
    },
    async listTasks(t, p, opts = {}) {
      return tasks.filter(x => x.tenant_id===t && x.property_id===p
        && (!opts.status || x.status === opts.status)
        && (!opts.assigned_to || x.assigned_to === opts.assigned_to));
    }
  };
}

function _makeCostCenterMemoryRepo() {
  const _id = (() => { let n = 0; return (p) => p + '_' + (++n); })();
  const rows = [];
  return {
    _store: { rows },
    async insertCostCenter(rec) {
      if (rows.find((c) => c.tenant_id === rec.tenant_id && c.property_id === rec.property_id && c.code === rec.code)) {
        const e = new Error('duplicate'); e.code = '23505'; throw e;
      }
      const r = Object.assign({ id: _id('cc'), is_active: rec.is_active !== false,
                                 created_at: new Date().toISOString(),
                                 updated_at: new Date().toISOString() }, rec);
      rows.push(r); return r;
    },
    async findCostCenterById(t, id) { return rows.find((c) => c.tenant_id === t && c.id === id) || null; },
    async listCostCenters(t, p, opts = {}) {
      return rows.filter((c) => c.tenant_id === t && c.property_id === p
        && (!opts.activeOnly || c.is_active));
    },
    async updateCostCenter(t, id, patch) {
      const c = rows.find((x) => x.tenant_id === t && x.id === id);
      if (!c) return null;
      if (patch.name) c.name = patch.name;
      if (patch.type) c.type = patch.type;
      if (patch.description !== undefined) c.description = patch.description;
      c.updated_at = new Date().toISOString();
      return c;
    },
    async setCostCenterActive(t, id, active) {
      const c = rows.find((x) => x.tenant_id === t && x.id === id);
      if (!c) return null;
      c.is_active = active; c.updated_at = new Date().toISOString();
      return c;
    }
  };
}

function _makeRevenueMapMemoryRepo() {
  const _id = (() => { let n = 0; return (p) => p + '_' + (++n); })();
  const rows = [];
  return {
    _store: { rows },
    async upsertRevenueMap(rec) {
      const i = rows.findIndex((m) => m.tenant_id === rec.tenant_id
        && m.property_id === rec.property_id && m.event_type === rec.event_type);
      if (i >= 0) {
        rows[i] = Object.assign({}, rows[i], rec);
        return rows[i];
      }
      const r = Object.assign({ id: _id('rm'), is_active: rec.is_active !== false }, rec);
      rows.push(r); return r;
    },
    async findRevenueMap(t, p, eventType) {
      return rows.find((m) => m.tenant_id === t && m.property_id === p && m.event_type === eventType && m.is_active) || null;
    },
    async listRevenueMaps(t, p) {
      return rows.filter((m) => m.tenant_id === t && m.property_id === p);
    },
    async deleteRevenueMap(t, p, eventType) {
      const i = rows.findIndex((m) => m.tenant_id === t && m.property_id === p && m.event_type === eventType);
      if (i < 0) return 0;
      rows.splice(i, 1);
      return 1;
    }
  };
}

function _makeLedgerMemoryRepo() {
  const _id = (() => { let n = 0; return (p) => p + '_' + (++n); })();
  const entries = [];
  const batches = [];
  return {
    _store: { entries, batches },
    async insertLedgerBatch(rec) {
      const r = Object.assign({ id: _id('bat'), created_at: new Date().toISOString() }, rec);
      batches.push(r); return r;
    },
    async insertLedgerEntry(rec) {
      const r = Object.assign({ id: _id('le'), created_at: new Date().toISOString(),
                                debit_amount: rec.debit_amount || 0,
                                credit_amount: rec.credit_amount || 0 }, rec);
      entries.push(r); return r;
    },
    async findLedgerByReference(t, refType, refId) {
      return entries.filter((e) => e.tenant_id === t && e.reference_type === refType && e.reference_id === refId);
    },
    async listLedgerByBatch(batchId) {
      return entries.filter((e) => e.batch_id === batchId);
    },
    async revertBatch(t, batchId) {
      const b = batches.find((x) => x.id === batchId && x.tenant_id === t);
      if (!b || b.reverted_at) return null;
      // Insert reversing entries
      const original = entries.filter((e) => e.batch_id === batchId);
      const revBatch = await this.insertLedgerBatch({ tenant_id: t, property_id: b.property_id,
        entry_type: 'REVERSAL', reference_type: 'ledger_batch', reference_id: batchId,
        currency: b.currency });
      for (const e of original) {
        await this.insertLedgerEntry({
          tenant_id: t, property_id: e.property_id, batch_id: revBatch.id,
          entry_type: 'REVERSAL', reference_type: 'ledger_batch', reference_id: batchId,
          cost_center_id: e.cost_center_id,
          account_code: e.account_code,
          debit_amount: e.credit_amount, credit_amount: e.debit_amount,
          currency: e.currency
        });
      }
      b.reverted_at = new Date().toISOString();
      b.reverted_by_batch_id = revBatch.id;
      return revBatch;
    },
    async reportByCostCenter(t, p, { dateFrom, dateTo } = {}) {
      const cc = new Map();
      for (const e of entries) {
        if (e.tenant_id !== t || e.property_id !== p) continue;
        if (dateFrom && e.created_at < dateFrom) continue;
        if (dateTo && e.created_at > dateTo) continue;
        const key = e.cost_center_id || 'NONE';
        const row = cc.get(key) || { cost_center_id: e.cost_center_id, debit: 0, credit: 0 };
        row.debit += Number(e.debit_amount);
        row.credit += Number(e.credit_amount);
        cc.set(key, row);
      }
      return Array.from(cc.values());
    },
    async revenueSummary(t, p) {
      let total = 0;
      for (const e of entries) {
        if (e.tenant_id !== t || e.property_id !== p) continue;
        if (e.entry_type === 'INVOICE') total += Number(e.credit_amount);
      }
      return { total_revenue: total };
    }
  };
}

function _makeNightAuditMemoryRepo(pmsRepoRef) {
  const _id = (() => { let n = 0; return (p) => p + '_' + (++n); })();
  const runs = [];
  return {
    _store: { runs },
    _propertyLocks: new Map(),    // property_id -> boolean
    _propertyDates: new Map(),    // property_id -> 'YYYY-MM-DD'
    async insertRun(rec) {
      const r = Object.assign({ id: _id('na'), started_at: new Date().toISOString() }, rec);
      runs.push(r); return r;
    },
    async completeRun(t, id, payload) {
      const r = runs.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      r.status = 'COMPLETED'; r.completed_at = new Date().toISOString();
      Object.assign(r, payload, { payload });
      return r;
    },
    async failRun(t, id, err) {
      const r = runs.find(x => x.tenant_id===t && x.id===id);
      if (!r) return null;
      r.status = 'FAILED'; r.completed_at = new Date().toISOString();
      r.error = String((err && err.message) || err);
      return r;
    },
    async findLatestRun(t, p) {
      const xs = runs.filter(x => x.tenant_id===t && x.property_id===p);
      return xs[xs.length - 1] || null;
    },
    async setPropertyBusinessDateLocked(t, p, locked) { this._propertyLocks.set(p, !!locked); },
    async advancePropertyBusinessDate(t, p, newDate) {
      this._propertyDates.set(p, newDate);
      this._propertyLocks.set(p, false);
    }
  };
}

function issueTestToken({ userId = USER_ID, tenantId = TENANT_A, roleCodes = [], primaryPropertyId = null } = {}) {
  const r = tokens.issueAccessToken({
    userId, tenantId, primaryPropertyId,
    roleCodes, roleIds: roleCodes.map((c) => 'role-' + c)
  });
  return r.token;
}

function authHeader(token) { return { 'Authorization': 'Bearer ' + token }; }

const http = require('node:http');
function listen(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, url: 'http://127.0.0.1:' + port });
    });
  });
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

module.exports = {
  TENANT_A, TENANT_B, USER_ID, PROP_ID,
  makeFakeDb, makeFakeRepos, issueTestToken, authHeader, listen, fetchJson
};

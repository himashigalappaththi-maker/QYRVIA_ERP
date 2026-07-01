// Domain service layer - thin REST callers over apiClient. The frontend holds
// NO business logic; it only maps UI intents to backend endpoints. Every path
// below corresponds to a route that EXISTS on the backend today (Phases 11-18):
//   /api/auth      routes/auth.js
//   /api/pms       routes/pms.js
//   /api/finance   routes/finance.js
//   /api/revenue   revenue/api/revenue.routes.js
//   /api/channel   channel-manager/api/channel.routes.js
//   /api/platform  platform/api/platform.routes.js
// No speculative endpoints. Reads the backend does not expose are simply absent
// here (the corresponding screens degrade gracefully).

export function createServices(api) {
  return {
    auth: {
      login: (payload) => api.post('/auth/login', payload),
      logout: (refreshToken) => api.post('/auth/logout', { refresh_token: refreshToken }),
      refresh: (refreshToken) => api.post('/auth/refresh', { refresh_token: refreshToken }),
      me: () => api.get('/auth/me'),
      properties: () => api.get('/auth/properties'),
      switchProperty: (propertyId) => api.post('/auth/switch-property', { property_id: propertyId }),
      register: (body) => api.post('/auth/register', body)
    },

    // ---- Reservations + Front Desk (pms) --------------------------------
    reservations: {
      list: (q) => api.get('/pms/reservations', { query: q }),
      byNumber: (n) => api.get('/pms/reservations/number/' + encodeURIComponent(n)),
      create: (body) => api.post('/pms/reservations', body),
      update: (id, body) => api.put('/pms/reservations/' + id, body),                 // Phase 36: edit
      roomMove: (id, roomId) => api.post('/pms/reservations/' + id + '/room-move', { room_id: roomId }), // Phase 36
      confirm: (id) => api.post('/pms/reservations/' + id + '/confirm', {}),
      cancel: (id, reason) => api.post('/pms/reservations/' + id + '/cancel', { reason }),
      noShow: (id) => api.post('/pms/reservations/' + id + '/no-show', {}),
      checkIn: (id, assignedRoomId) => api.post('/pms/reservations/' + id + '/checkin', { assigned_room_id: assignedRoomId || undefined }),
      checkOut: (id, force) => api.post('/pms/reservations/' + id + '/checkout', { force_close: !!force })
    },
    // ---- Front Desk dedicated reads (Phase 36) --------------------------
    frontdesk: {
      arrivals: (q) => api.get('/pms/frontdesk/arrivals', { query: q }),
      departures: (q) => api.get('/pms/frontdesk/departures', { query: q }),
      inhouse: (q) => api.get('/pms/frontdesk/inhouse', { query: q })
    },
    groups: {
      create: (body) => api.post('/pms/reservation-groups', body),
      byId: (id) => api.get('/pms/reservation-groups/' + id),
      roomingList: (id) => api.get('/pms/reservation-groups/' + id + '/rooming-list'),
      addRoom: (id, reservationId) => api.post('/pms/reservation-groups/' + id + '/rooms', { reservation_id: reservationId }),
      cancelAll: (id, reason, force) => api.post('/pms/reservation-groups/' + id + '/cancel-all', { reason, force: !!force }),
      checkinAll: (id) => api.post('/pms/reservation-groups/' + id + '/checkin-all', {})
    },

    // ---- Guests ---------------------------------------------------------
    guests: {
      list: (q) => api.get('/pms/guests', { query: q }),
      byId: (id) => api.get('/pms/guests/' + id),
      create: (body) => api.post('/pms/guests', body),
      blacklist: (id, flag) => api.post('/pms/guests/' + id + '/blacklist', { blacklisted: flag })
    },

    // ---- Rooms / room types / features ---------------------------------
    rooms: {
      list: (q) => api.get('/pms/rooms', { query: q }),
      byNumber: (n) => api.get('/pms/rooms/number/' + encodeURIComponent(n)),
      create: (body) => api.post('/pms/rooms', body),
      setStatus: (id, status) => api.post('/pms/rooms/' + id + '/status', { status }),
      activate: (id) => api.post('/pms/rooms/' + id + '/activate', {}),
      deactivate: (id) => api.post('/pms/rooms/' + id + '/deactivate', {}),
      roomTypes: () => api.get('/pms/room-types'),
      createRoomType: (body) => api.post('/pms/room-types', body),
      features: () => api.get('/pms/room-features'),
      createFeature: (body) => api.post('/pms/room-features', body),
      attachFeature: (roomId, featureId) => api.post('/pms/rooms/' + roomId + '/features/' + featureId, {})
    },

    // ---- Availability ---------------------------------------------------
    availability: {
      byDate: (q) => api.get('/pms/availability', { query: q }),
      calendar: (q) => api.get('/pms/availability/calendar', { query: q })
    },

    // ---- Rate plans + meal plans + child policies ----------------------
    ratePlans: {
      list: () => api.get('/pms/rate-plans'),
      byId: (id) => api.get('/pms/rate-plans/' + id),
      create: (body) => api.post('/pms/rate-plans', body),
      attachMealPlan: (id, mealPlanId) => api.post('/pms/rate-plans/' + id + '/meal-plan', { meal_plan_id: mealPlanId })
    },
    mealPlans: {
      list: () => api.get('/pms/meal-plans'),
      byId: (id) => api.get('/pms/meal-plans/' + id),
      create: (body) => api.post('/pms/meal-plans', body)
    },
    childPolicies: {
      list: () => api.get('/pms/child-policies'),
      byId: (id) => api.get('/pms/child-policies/' + id)
    },

    // ---- Billing: folios + invoices + vouchers -------------------------
    billing: {
      invoices: (q) => api.get('/pms/invoices', { query: q }),
      invoiceById: (id) => api.get('/pms/invoices/' + id),
      invoiceByNumber: (n) => api.get('/pms/invoices/number/' + encodeURIComponent(n)),
      issueInvoice: (body) => api.post('/pms/invoices/issue', body),
      voidInvoice: (id, reason) => api.post('/pms/invoices/' + id + '/void', { reason }),
      postCharge: (folioId, body) => api.post('/pms/folios/' + folioId + '/charges', body),
      cashPayment: (folioId, body) => api.post('/pms/folios/' + folioId + '/payments/cash', body),
      closeFolio: (folioId, force) => api.post('/pms/folios/' + folioId + '/close', { force: !!force }),
      allocations: (folioId, paymentLineId) => api.get('/pms/folios/' + folioId + '/allocations', { query: { payment_line_id: paymentLineId } }),
      allocate: (folioId, paymentLineId, body) => api.post('/pms/folios/' + folioId + '/payments/' + paymentLineId + '/allocate', body),
      folios: (q) => api.get('/pms/folios', { query: q }),                  // Phase 36: folio browser
      folioById: (id) => api.get('/pms/folios/' + id)
    },
    vouchers: {
      byNumber: (n) => api.get('/pms/vouchers/' + encodeURIComponent(n)),
      issue: (body) => api.post('/pms/vouchers', body),
      redeem: (n, reservationId) => api.post('/pms/vouchers/' + encodeURIComponent(n) + '/redeem', { reservation_id: reservationId }),
      cancel: (n, reason) => api.post('/pms/vouchers/' + encodeURIComponent(n) + '/cancel', { reason })
    },

    // ---- Housekeeping (Phase 36: dedicated reads now wired) ------------
    housekeeping: {
      tasks: (q) => api.get('/pms/housekeeping/tasks', { query: q }),
      roomStatus: (q) => api.get('/pms/housekeeping/room-status', { query: q }),
      createTask: (body) => api.post('/pms/housekeeping/tasks', body),
      assignTask: (id, userId) => api.post('/pms/housekeeping/tasks/' + id + '/assign', { user_id: userId }),
      completeTask: (id, body) => api.post('/pms/housekeeping/tasks/' + id + '/complete', body || {})
    },

    // ---- Night Audit (Phase 36: status/history reads now wired) --------
    nightAudit: {
      status: (q) => api.get('/pms/night-audit/status', { query: q }),
      history: (q) => api.get('/pms/night-audit/history', { query: q }),
      run: (body) => api.post('/pms/night-audit/run', body || {}),
      schedule: (body) => api.post('/pms/night-audit/schedule', body || {})
    },

    // ---- Revenue management --------------------------------------------
    revenue: {
      rate: (q) => api.get('/revenue/rate', { query: q }),
      rateGrid: (q) => api.get('/revenue/rate-grid', { query: q }),
      forecast: (q) => api.get('/revenue/forecast', { query: q }),
      kpis: (q) => api.get('/revenue/kpis', { query: q }),
      dashboard: (q) => api.get('/revenue/dashboard', { query: q }),
      setRatePlan: (body) => api.post('/revenue/rate-plan', body),
      override: (body) => api.post('/revenue/override', body)
    },

    // ---- Finance / Accounting ------------------------------------------
    finance: {
      costCenters: (q) => api.get('/finance/cost-centers', { query: q }),
      costCenterById: (id) => api.get('/finance/cost-centers/' + id),
      createCostCenter: (body) => api.post('/finance/cost-centers', body),
      updateCostCenter: (id, body) => api.put('/finance/cost-centers/' + id, body),
      disableCostCenter: (id) => api.post('/finance/cost-centers/' + id + '/disable', {}),
      revenueMap: () => api.get('/finance/revenue-map'),
      upsertRevenueMap: (body) => api.post('/finance/revenue-map', body),
      deleteRevenueMap: (body) => api.post('/finance/revenue-map/delete', body),
      ledgerByReference: (q) => api.get('/finance/ledger/by-reference', { query: q }),
      postLedger: (body) => api.post('/finance/ledger/post', body),
      validateLedger: (body) => api.post('/finance/ledger/validate', body),
      revertLedger: (body) => api.post('/finance/ledger/revert', body),
      reportCostCenter: (q) => api.get('/finance/reports/cost-center', { query: q }),
      reportRevenue: (q) => api.get('/finance/reports/revenue', { query: q })
    },

    // ---- Channel manager ------------------------------------------------
    channel: {
      status: () => api.get('/channel/status'),
      control: () => api.get('/channel/control'),          // Phase 25 control-center snapshot
      syncRates: (body) => api.post('/channel/sync/rates', body || {}),
      syncInventory: (body) => api.post('/channel/sync/inventory', body || {}),
      syncBookings: (body) => api.post('/channel/bookings/sync', body || {}),
      confirmBooking: (body) => api.post('/channel/bookings/confirm', body || {}),
      cancelBooking: (body) => api.post('/channel/bookings/cancel', body || {})
    },

    // ---- Booking Engine (official reservation entry point) -------------
    booking: {
      create: (body) => api.post('/booking/create', body || {}),
      update: (id, body) => api.post('/booking/update/' + encodeURIComponent(id), body || {}),
      cancel: (id, body) => api.post('/booking/cancel/' + encodeURIComponent(id), body || {})
    },

    // ---- Platform / Admin ----------------------------------------------
    platform: {
      metrics: () => api.get('/platform/admin/metrics'),
      logs: (q) => api.get('/platform/admin/logs', { query: q }),
      audit: (q) => api.get('/platform/admin/audit', { query: q }),
      integrations: () => api.get('/platform/integrations/status'),
      properties: () => api.get('/platform/enterprise/properties'),
      analytics: () => api.get('/platform/enterprise/analytics'),
      config: () => api.get('/platform/enterprise/config')
    },

    // ---- IAM (users + roles) - Phase 36 --------------------------------
    iam: {
      users: () => api.get('/iam/users'),
      roles: () => api.get('/iam/roles'),
      register: (body) => api.post('/auth/register', body) // create user (auth.user.create)
    },

    // ---- Settings (typed catalog) - Phase 36 ---------------------------
    settings: {
      schema: (category) => api.get('/settings/schema', { query: { category } }),
      spec: (category, key) => api.get('/settings/schema/' + encodeURIComponent(category) + '/' + encodeURIComponent(key)),
      list: (category) => api.get('/settings/' + encodeURIComponent(category)),
      get: (category, key) => api.get('/settings/' + encodeURIComponent(category) + '/' + encodeURIComponent(key)),
      set: (category, key, value, scope) => api.put('/settings/' + encodeURIComponent(category) + '/' + encodeURIComponent(key), { value, scope: scope || 'tenant' }),
      remove: (category, key, scope) => api.del('/settings/' + encodeURIComponent(category) + '/' + encodeURIComponent(key), { query: { scope: scope || 'tenant' } })
    },

    // ---- Scheduler / Jobs - Phase 36 -----------------------------------
    jobs: {
      schedule: (body) => api.post('/jobs', body),
      cancel: (id) => api.del('/jobs/' + encodeURIComponent(id)),
      run: (limit) => api.post('/jobs/run', { limit: limit || 25 })
    },

    // ---- Notifications - Phase 36 --------------------------------------
    notifications: {
      list: (q) => api.get('/notifications', { query: q }),
      byId: (id) => api.get('/notifications/' + encodeURIComponent(id)),
      request: (body) => api.post('/notifications', body),
      sendPending: (limit) => api.post('/notifications/send/run', { limit: limit || 25 })
    },

    // ---- Webhooks - Phase 36 ------------------------------------------
    webhooks: {
      list: () => api.get('/webhooks'),
      register: (body) => api.post('/webhooks', body),
      disable: (id) => api.del('/webhooks/' + encodeURIComponent(id)),
      deliverPending: (limit) => api.post('/webhooks/deliveries/run', { limit: limit || 25 })
    },

    // ---- Files - Phase 36 ---------------------------------------------
    files: {
      upload: (body) => api.post('/files', body),
      byId: (id) => api.get('/files/' + encodeURIComponent(id)),
      token: (id) => api.get('/files/' + encodeURIComponent(id) + '/token'),
      remove: (id) => api.del('/files/' + encodeURIComponent(id))
    },

    // ---- Connectors - Phase 36 ----------------------------------------
    connectors: {
      list: () => api.get('/connectors'),
      config: (code) => api.get('/connectors/' + encodeURIComponent(code) + '/config'),
      configure: (code, body) => api.put('/connectors/' + encodeURIComponent(code) + '/config', body),
      probe: (code) => api.post('/connectors/' + encodeURIComponent(code) + '/probe', {}),
      health: (code) => api.post('/connectors/' + encodeURIComponent(code) + '/health', {})
    }
  };
}

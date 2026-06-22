// Domain service layer - thin REST callers over apiClient. Frontend holds NO
// business logic; it only maps UI intents to backend endpoints. Endpoint paths
// follow the documented contract (apiClient baseUrl = '/api').

export function createServices(api) {
  return {
    auth: {
      login: (payload) => api.post('/auth/login', payload),
      logout: () => api.post('/auth/logout', {}),
      refresh: (refreshToken) => api.post('/auth/refresh', { refreshToken })
    },
    frontdesk: {
      listReservations: (q) => api.get('/reservations', { query: q }),
      stays: (q) => api.get('/frontdesk/stays', { query: q }),
      checkIn: (reservationId) => api.post('/frontdesk/check-in', { reservation_id: reservationId }),
      checkOut: (reservationId) => api.post('/frontdesk/check-out', { reservation_id: reservationId })
    },
    billing: {
      folios: (q) => api.get('/billing/folios', { query: q }),
      invoices: (q) => api.get('/billing/invoices', { query: q }),
      payments: (folioId) => api.get('/billing/payments', { query: { folio_id: folioId } })
    },
    housekeeping: {
      tasks: (q) => api.get('/housekeeping/tasks', { query: q }),
      roomStatus: (q) => api.get('/housekeeping/rooms', { query: q })
    },
    revenue: {
      rateGrid: (q) => api.get('/revenue/rate-grid', { query: q }),
      forecast: (q) => api.get('/revenue/forecast', { query: q }),
      kpis: (q) => api.get('/revenue/kpis', { query: q }),
      dashboard: (q) => api.get('/revenue/dashboard', { query: q }),
      override: (body) => api.post('/revenue/override', body)
    },
    nightaudit: {
      status: () => api.get('/nightaudit/status'),
      history: () => api.get('/nightaudit/history'),
      run: () => api.post('/nightaudit/run', {})
    },
    platform: {
      metrics: () => api.get('/platform/admin/metrics'),
      logs: (q) => api.get('/platform/admin/logs', { query: q }),
      audit: (q) => api.get('/platform/admin/audit', { query: q }),
      integrations: () => api.get('/platform/integrations/status'),
      properties: () => api.get('/platform/enterprise/properties'),
      analytics: () => api.get('/platform/enterprise/analytics'),
      config: () => api.get('/platform/enterprise/config')
    }
  };
}

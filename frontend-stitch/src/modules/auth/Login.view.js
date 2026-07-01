// Login view - the only pre-auth screen. Calls /auth/login, normalizes the
// response into a session, then routes to the dashboard.
import { on, qs } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';

function normalizeSession(res) {
  const expiresAt = res.expiresAt
    || (res.access_expires_at ? Date.parse(res.access_expires_at) : null)
    || (res.expires_in ? Date.now() + Number(res.expires_in) * 1000 : null);
  const roles = (res.roles || (res.user && res.user.roles) || []).map((r) => (typeof r === 'object' ? r.code : r));
  return {
    token: res.token || res.access_token || res.accessToken || null,
    refreshToken: res.refreshToken || res.refresh_token || null,
    expiresAt: Number.isNaN(expiresAt) ? null : expiresAt,
    principal: res.principal || {
      userId: (res.user && (res.user.username || res.user.id)) || res.user_id || res.username || 'user',
      roles,
      // Real backend permission codes - authoritative for client RBAC (UX) hiding.
      permissions: res.permissions || (res.user && res.user.permissions) || [],
      propertyId: (res.user && res.user.primary_property_id) || res.property_id || null,
      propertyCode: (res.user && res.user.primary_property_code) || res.property_code || null
    }
  };
}

export function LoginView({ services, session, navigate }) {
  return {
    render(appEl) {
      appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center bg-background px-4">
        <div class="w-full max-w-md">
          <div class="text-center mb-8">
            <span class="material-symbols-outlined text-primary text-4xl">hotel</span>
            <h1 class="font-display text-3xl font-bold mt-2">QYRVIA</h1>
            <p class="text-slate text-sm">Hospitality Enterprise Platform</p>
          </div>
          <div class="card bg-surface rounded-xl shadow-card p-8">
            <form id="login-form" class="space-y-4">
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Tenant / Property Code</label>
                <input name="code" required class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Username</label>
                <input name="username" required autocomplete="username" class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Password</label>
                <input name="password" type="password" required autocomplete="current-password" class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <button type="submit" class="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-medium hover:shadow-card">Sign in</button>
            </form>
          </div>
        </div></div>`;

      on(appEl, '#login-form', 'submit', async (e) => {
        e.preventDefault();
        const f = qs('#login-form', appEl);
        const payload = { tenant_code: f.code.value.trim(), username: f.username.value.trim(), password: f.password.value };
        try {
          const res = await services.auth.login(payload);
          const s = normalizeSession(res);
          if (!s.token) { toast('Login response missing token', 'error'); return; }
          session.save(s);
          navigate('/dashboard');
        } catch (err) {
          toast(err && err.status === 401 ? 'Invalid credentials' : ((err && err.message) || 'Login failed'), 'error');
        }
      });
    }
  };
}

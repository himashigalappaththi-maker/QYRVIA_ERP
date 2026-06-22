// Login view - the only pre-auth screen. Calls /auth/login, normalizes the
// response into a session, then routes to the dashboard.
import { on, qs } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';

function normalizeSession(res) {
  return {
    token: res.token || res.access_token || res.accessToken || null,
    refreshToken: res.refreshToken || res.refresh_token || null,
    expiresAt: res.expiresAt || (res.expires_in ? Date.now() + Number(res.expires_in) * 1000 : null),
    principal: res.principal || {
      userId: res.user_id || res.username || (res.user && res.user.id) || 'user',
      roles: res.roles || (res.user && res.user.roles) || [],
      properties: res.properties || (res.user && res.user.properties) || []
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

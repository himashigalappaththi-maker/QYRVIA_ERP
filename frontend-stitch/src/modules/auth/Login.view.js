// Login view - Phase 57: email+password is the primary path.
// A "Use tenant code instead" toggle reveals the legacy tenant_code+username form
// for back-office / development access. The server supports both paths.
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
      permissions: res.permissions || (res.user && res.user.permissions) || [],
      propertyId: (res.user && res.user.primary_property_id) || res.property_id || null,
      propertyCode: (res.user && res.user.primary_property_code) || res.property_code || null
    },
    // Phase 57: multi-property fields
    requiresPropertySelection: res.requires_property_selection || false,
    authorisedProperties: res.authorised_properties || []
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
            <!-- Phase 57 default: email + password -->
            <form id="login-form-email" class="space-y-4">
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Email</label>
                <input name="email" type="email" required autocomplete="email"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Password</label>
                <input name="password" type="password" required autocomplete="current-password"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <button type="submit"
                class="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-medium hover:shadow-card">
                Sign in
              </button>
              <div class="text-center pt-1">
                <button type="button" id="toggle-legacy"
                  class="text-xs text-slate hover:underline">Use tenant code instead</button>
              </div>
            </form>

            <!-- Legacy path: tenant_code + username (hidden by default) -->
            <form id="login-form-legacy" class="space-y-4 hidden">
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Tenant / Property Code</label>
                <input name="code" autocomplete="organization"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Username</label>
                <input name="username" autocomplete="username"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Password</label>
                <input name="password" type="password" autocomplete="current-password"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <button type="submit"
                class="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-medium hover:shadow-card">
                Sign in
              </button>
              <div class="text-center pt-1">
                <button type="button" id="toggle-email"
                  class="text-xs text-slate hover:underline">Sign in with email</button>
              </div>
            </form>
          </div>
        </div></div>`;

      // Toggle between the two form modes
      on(appEl, '#toggle-legacy', 'click', () => {
        qs('#login-form-email', appEl).classList.add('hidden');
        qs('#login-form-legacy', appEl).classList.remove('hidden');
      });
      on(appEl, '#toggle-email', 'click', () => {
        qs('#login-form-legacy', appEl).classList.add('hidden');
        qs('#login-form-email', appEl).classList.remove('hidden');
      });

      // Email path handler
      on(appEl, '#login-form-email', 'submit', async (e) => {
        e.preventDefault();
        const f = qs('#login-form-email', appEl);
        try {
          const res = await services.auth.login({ email: f.email.value.trim(), password: f.password.value });
          await _handleLoginResponse(res, navigate, session);
        } catch (err) {
          toast(_loginErrorMessage(err), 'error');
        }
      });

      // Legacy tenant_code path handler
      on(appEl, '#login-form-legacy', 'submit', async (e) => {
        e.preventDefault();
        const f = qs('#login-form-legacy', appEl);
        const code = f.code.value.trim();
        // Detect whether it's a tenant code or property code (heuristic: property codes contain hyphens)
        const payload = code.includes('-')
          ? { property_code: code, username: f.username.value.trim(), password: f.password.value }
          : { tenant_code: code,   username: f.username.value.trim(), password: f.password.value };
        try {
          const res = await services.auth.login(payload);
          await _handleLoginResponse(res, navigate, session);
        } catch (err) {
          toast(_loginErrorMessage(err), 'error');
        }
      });
    }
  };
}

async function _handleLoginResponse(res, navigate, session) {
  const s = normalizeSession(res);
  if (!s.token) { toast('Login response missing token', 'error'); return; }
  session.save(s);
  // Phase 57: PENDING_PASSWORD_RESET — must complete password change before anything else
  if (res.requires_password_change) {
    const token = res.password_reset_token;
    navigate(token
      ? '/complete-password-reset?token=' + encodeURIComponent(token)
      : '/complete-password-reset');
    return;
  }
  // Phase 57: multi-property — user must pick a property before reaching the app
  if (s.requiresPropertySelection && s.authorisedProperties.length > 1) {
    navigate('/select-property');
  } else {
    navigate('/dashboard');
  }
}

function _loginErrorMessage(err) {
  if (!err) return 'Login failed';
  if (err.status === 401) return 'Invalid credentials';
  return err.message || 'Login failed';
}

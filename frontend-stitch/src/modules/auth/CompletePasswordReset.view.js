// Phase 57: Complete a password reset using the token from the reset email URL.
// Token is expected in the URL query string: ?token=<raw_token>
import { on, qs } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';

export function CompletePasswordResetView({ services, navigate }) {
  return {
    render(appEl) {
      const token = _tokenFromUrl();

      if (!token) {
        appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center bg-background px-4">
          <div class="card bg-surface rounded-xl shadow-card p-8 max-w-md w-full text-center">
            <p class="text-error">Reset link is invalid or missing.</p>
            <button class="mt-4 text-sm underline" onclick="history.back()">Go back</button>
          </div></div>`;
        return;
      }

      appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center bg-background px-4">
        <div class="w-full max-w-md">
          <div class="text-center mb-8">
            <span class="material-symbols-outlined text-primary text-4xl">hotel</span>
            <h1 class="font-display text-3xl font-bold mt-2">QYRVIA</h1>
            <p class="text-slate text-sm">Choose a new password</p>
          </div>
          <div class="card bg-surface rounded-xl shadow-card p-8">
            <form id="reset-complete-form" class="space-y-4">
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">New Password</label>
                <input name="newPassword" type="password" required autocomplete="new-password"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Confirm Password</label>
                <input name="confirm" type="password" required autocomplete="new-password"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <button type="submit"
                class="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-medium hover:shadow-card">
                Set New Password
              </button>
            </form>
          </div>
        </div></div>`;

      on(appEl, '#reset-complete-form', 'submit', async (e) => {
        e.preventDefault();
        const f = qs('#reset-complete-form', appEl);
        if (f.newPassword.value !== f.confirm.value) {
          toast('Passwords do not match', 'error');
          return;
        }
        try {
          await services.auth.completePasswordReset(token, f.newPassword.value);
          toast('Password updated — please sign in', 'success');
          navigate('/login');
        } catch (err) {
          const code = err && err.body && err.body.error;
          const messages = {
            reset_token_invalid:  'This reset link is invalid.',
            reset_token_used:     'This reset link has already been used.',
            reset_token_expired:  'This reset link has expired. Please request a new one.',
            password_too_short:   'Password must be at least 8 characters.'
          };
          toast(messages[code] || (err && err.message) || 'Could not reset password', 'error');
        }
      });
    }
  };
}

function _tokenFromUrl() {
  try {
    // Hash-SPA: navigate('/complete-password-reset?token=xxx') sets the hash to
    // '#/complete-password-reset?token=xxx', so the token is in the hash fragment,
    // not in window.location.search.  Fall back to search for direct deep-links.
    const hash = (window.location.hash || '').replace(/^#/, '');
    const hashQuery = hash.includes('?') ? hash.split('?')[1] : '';
    const token = new URLSearchParams(hashQuery).get('token')
               || new URLSearchParams(window.location.search).get('token')
               || null;
    return token;
  } catch (_) {
    return null;
  }
}

// Phase 57: Accept an invitation via a secure token embedded in the invite URL.
// The token is expected in the URL query string: ?token=<raw_token>
// After successful acceptance, the user is directed to the login screen.
import { on, qs } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';

export function AcceptInvitationView({ services, navigate }) {
  return {
    render(appEl) {
      const token = _tokenFromUrl();

      if (!token) {
        appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center bg-background px-4">
          <div class="card bg-surface rounded-xl shadow-card p-8 max-w-md w-full text-center">
            <p class="text-error">Invitation link is invalid or missing.</p>
            <button class="mt-4 text-sm underline" onclick="history.back()">Go back</button>
          </div></div>`;
        return;
      }

      appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center bg-background px-4">
        <div class="w-full max-w-md">
          <div class="text-center mb-8">
            <span class="material-symbols-outlined text-primary text-4xl">hotel</span>
            <h1 class="font-display text-3xl font-bold mt-2">QYRVIA</h1>
            <p class="text-slate text-sm">Create your account</p>
          </div>
          <div class="card bg-surface rounded-xl shadow-card p-8">
            <form id="accept-form" class="space-y-4">
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Full Name</label>
                <input name="fullName" required autocomplete="name"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Password</label>
                <input name="password" type="password" required autocomplete="new-password"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Confirm Password</label>
                <input name="passwordConfirm" type="password" required autocomplete="new-password"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <button type="submit"
                class="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-medium hover:shadow-card">
                Create Account
              </button>
            </form>
          </div>
        </div></div>`;

      on(appEl, '#accept-form', 'submit', async (e) => {
        e.preventDefault();
        const f = qs('#accept-form', appEl);
        if (f.password.value !== f.passwordConfirm.value) {
          toast('Passwords do not match', 'error');
          return;
        }
        try {
          await services.auth.acceptInvitation(token, f.fullName.value.trim(), f.password.value);
          toast('Account created — please sign in', 'success');
          navigate('/login');
        } catch (err) {
          const code = err && err.body && err.body.error;
          const messages = {
            invitation_expired:     'This invitation has expired.',
            invitation_already_used:'This invitation has already been used.',
            invitation_not_found:   'Invitation not found or invalid.',
            password_too_short:     'Password must be at least 8 characters.',
            email_already_registered: 'An account with this email already exists.'
          };
          toast(messages[code] || (err && err.message) || 'Could not accept invitation', 'error');
        }
      });
    }
  };
}

function _tokenFromUrl() {
  try {
    // Hash-SPA: token is in the hash fragment query string when navigated to via
    // navigate('/accept-invitation?token=xxx').  Fall back to search for deep-links.
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

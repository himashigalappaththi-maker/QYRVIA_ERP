// Phase 57: Request a password reset. Always shows success message (enumeration-safe).
import { on, qs } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';

export function RequestPasswordResetView({ services, navigate }) {
  return {
    render(appEl) {
      appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center bg-background px-4">
        <div class="w-full max-w-md">
          <div class="text-center mb-8">
            <span class="material-symbols-outlined text-primary text-4xl">hotel</span>
            <h1 class="font-display text-3xl font-bold mt-2">QYRVIA</h1>
            <p class="text-slate text-sm">Reset your password</p>
          </div>
          <div class="card bg-surface rounded-xl shadow-card p-8">
            <form id="reset-request-form" class="space-y-4">
              <p class="text-sm text-slate">
                Enter your email address and we'll send a reset link if an account exists.
              </p>
              <div><label class="block text-xs uppercase tracking-wider text-slate mb-1">Email</label>
                <input name="email" type="email" required autocomplete="email"
                  class="w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none" /></div>
              <button type="submit"
                class="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-medium hover:shadow-card">
                Send Reset Link
              </button>
              <div class="text-center pt-1">
                <button type="button" onclick="history.back()"
                  class="text-xs text-slate hover:underline">Back to sign in</button>
              </div>
            </form>
          </div>
        </div></div>`;

      on(appEl, '#reset-request-form', 'submit', async (e) => {
        e.preventDefault();
        const f = qs('#reset-request-form', appEl);
        try {
          // Server always returns 200/ok:true — we show a generic success message
          await services.auth.requestPasswordReset(f.email.value.trim());
          toast('If an account exists for that email, a reset link has been sent.', 'success');
          navigate('/login');
        } catch (err) {
          // Unexpected error (network, 5xx) — still show generic message for safety
          toast('If an account exists for that email, a reset link has been sent.', 'success');
          navigate('/login');
          void err;
        }
      });
    }
  };
}

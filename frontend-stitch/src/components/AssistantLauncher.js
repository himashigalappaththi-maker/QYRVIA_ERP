// AI assistant launcher (Stitch). Uses the brand assistant avatar. Honest by
// design: there is no AI backend wired in this build, so the panel says so
// rather than faking responses (consistent with the platform's "no fake AI"
// rule). When an assistant API exists, this panel becomes its surface.
import { on } from '../utils/dom.js';

export function assistantLauncherHTML() {
  return `<div class="fixed bottom-6 right-6 z-40 lg:bottom-8 lg:right-8">
    <div id="assistant-panel" class="hidden mb-3 w-72 bg-surface rounded-xl shadow-modal border border-outline-variant/40 p-4">
      <div class="flex items-center gap-2 mb-2">
        <img src="./assets/ai-assistant.png" class="w-7 h-7 rounded-full object-cover" alt="" onerror="this.style.display='none'" />
        <p class="font-display font-semibold text-sm">QYRVIA Assistant</p>
      </div>
      <p class="text-xs text-on-surface-variant">The assistant is not connected to an AI service in this build. It will activate here once an assistant endpoint is enabled on the platform.</p>
    </div>
    <button data-action="assistant-toggle" aria-label="Assistant"
      class="w-14 h-14 rounded-full bg-primary shadow-modal flex items-center justify-center hover:scale-95 transition-transform overflow-hidden">
      <img src="./assets/ai-assistant.png" class="w-full h-full object-cover" alt="Assistant" onerror="this.outerHTML='<span class=\\'material-symbols-outlined text-on-primary\\'>smart_toy</span>'" />
    </button>
  </div>`;
}

export function wireAssistant(root) {
  on(root, '[data-action="assistant-toggle"]', 'click', () => {
    const panel = root.querySelector('#assistant-panel');
    if (panel) panel.classList.toggle('hidden');
  });
}

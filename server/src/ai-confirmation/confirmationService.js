'use strict';

/**
 * confirmationService (Phase 27.3) - orchestrates post-booking confirmation:
 *
 *   booking event -> resolve recipient + confidence -> decision tree
 *      suppress     : record + stop (no guest message)
 *      escalate     : push to the escalation sink for staff follow-up
 *      auto_confirm : render template -> enqueue -> (drain) -> deliver via transport
 *
 * It is a pure CONSUMER of booking events emitted by the Booking Engine; it performs
 * no PMS/OTA writes and no DB mutations. Confirmation text is deterministic and
 * system-rendered (no LLM). Default transport is a MOCK (no external network call),
 * and is injectable so a real WhatsApp transport can be supplied later (Phase 27.2+).
 */

const { buildConfirmationQueue } = require('./confirmationQueue');
const { decideConfirmation } = require('./escalationPolicy');
const { renderConfirmation } = require('./confirmationTemplates');

/** MOCK transport: records to an in-memory outbox; never touches the network. */
function buildMockConfirmationTransport() {
  const outbox = [];
  return {
    kind: 'mock',
    outbox,
    async send(to, message, meta) { outbox.push({ to, message, meta: meta || null, at: Date.now() }); return { ok: true }; },
    async close() {}
  };
}

/** Default recipient resolver: explicit field, else decode an AI_WHATSAPP `wa:<number>` external_ref. */
function defaultContactResolver(ev) {
  if (!ev) return null;
  if (ev.recipient) return ev.recipient;
  const ref = ev.external_ref;
  if (typeof ref === 'string' && ref.startsWith('wa:')) { const n = ref.slice(3).trim(); return n || null; }
  return null;
}

function idempotencyKey(ev) {
  return [ev.tenant_id || '', ev.channel || '', ev.type || '', ev.reservation_id || ev.external_ref || ''].join('|');
}

function buildConfirmationService({
  transport, queue, escalationSink, contactResolver, confidenceResolver,
  autoSend = true, minConfidence = 0.5, locale = 'en', retryPolicy, clock, sleep
} = {}) {
  const tx = transport || buildMockConfirmationTransport();
  const q = queue || buildConfirmationQueue({ transport: tx, retryPolicy, clock, sleep });
  const escalations = escalationSink || [];
  const suppressed = [];
  const now = clock || (() => Date.now());
  const resolveContact = contactResolver || defaultContactResolver;
  const resolveConfidence = confidenceResolver || ((ev) => (ev && ev.ai_confidence != null ? Number(ev.ai_confidence) : 1));

  /**
   * Process one booking event. Returns the decision outcome. Auto-confirm only
   * ENQUEUES; call drain() (or use onEvent) to actually deliver.
   */
  async function handleEvent(event) {
    const ev = event || {};
    const recipient = resolveContact(ev);
    const confidence = resolveConfidence(ev);
    const decision = decideConfirmation(ev, { recipient, confidence, autoSend, minConfidence });

    if (decision.decision === 'suppress') {
      const rec = { event: ev, reasons: decision.reasons, at: now() };
      suppressed.push(rec);
      return { decision: 'suppress', reasons: decision.reasons };
    }

    const message = renderConfirmation(ev, { locale });

    if (decision.decision === 'escalate') {
      const esc = { event: ev, recipient: recipient || null, message, reasons: decision.reasons, at: now() };
      escalations.push(esc);
      return { decision: 'escalate', reasons: decision.reasons, recipient: recipient || null, message };
    }

    // auto_confirm
    const enq = q.enqueue({ key: idempotencyKey(ev), to: recipient, message, meta: { type: ev.type, reservation_id: ev.reservation_id, tenant_id: ev.tenant_id, channel: ev.channel } });
    return { decision: 'auto_confirm', queued: !!enq.accepted, deduped: !!enq.deduped, to: recipient, message };
  }

  function drain() { return q.drain(); }

  // ---- operational / API accessors ---------------------------------------
  // All reads are tenant-scoped when a tenantId is supplied (multi-tenant isolation).
  const tenantOf = (r) => (r && r.event && r.event.tenant_id) || (r && r.meta && r.meta.tenant_id) || null;
  const scope = (list, tenantId) => (tenantId ? list.filter((r) => tenantOf(r) === tenantId) : list.slice());

  function stats(tenantId) {
    return {
      autoSend, minConfidence,
      queue: q.stats(),
      escalations: scope(escalations, tenantId).length,
      suppressed: scope(suppressed, tenantId).length,
      sent: scope(q.sent, tenantId).length,
      deadLetter: scope(q.deadLetter, tenantId).length
    };
  }
  function listEscalations(tenantId) { return scope(escalations, tenantId); }
  function listDeadLetter(tenantId) { return scope(q.deadLetter, tenantId); }
  function replayDeadLetter() { return q.replayDeadLetter(); }

  /**
   * onEvent: the synchronous, never-throwing hook handed to the Booking Engine's
   * `onEvent` DI param. It schedules the async handle + drain and swallows all
   * errors so a confirmation failure can never affect a booking write.
   */
  function onEvent(event) {
    try {
      handleEvent(event)
        .then((r) => { if (r && r.decision === 'auto_confirm' && r.queued) return drain(); })
        .catch(() => {});
    } catch (_) { /* never throws */ }
  }

  return { handleEvent, drain, onEvent, stats, listEscalations, listDeadLetter, replayDeadLetter, queue: q, transport: tx, escalations, suppressed };
}

module.exports = { buildConfirmationService, buildMockConfirmationTransport, defaultContactResolver, idempotencyKey };

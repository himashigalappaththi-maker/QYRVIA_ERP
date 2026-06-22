'use strict';

/**
 * Settings Catalog Bootstrap (Phase 6 / C14).
 *
 * Registers every typed (category, key) tunable the platform knows
 * about. Called once at server boot from src/index.js.
 *
 * Unknown keys remain accepted by settingsService.set() for backward
 * compatibility - the validator only enforces shape for REGISTERED keys.
 * Registering a key here is equivalent to "this is a real platform
 * tunable; reject malformed writes against it".
 */

const { registerSpec } = require('./settingsService');

function bootstrapSettingsCatalog() {
  // ---- multi_property ---------------------------------------------------
  registerSpec('multi_property', 'switcher_remember_choice', {
    value_type: 'boolean', default_value_json: true,
    description: 'When true, the UI remembers the last property switched into.'
  });

  // ---- night_audit ------------------------------------------------------
  registerSpec('night_audit', 'cron', {
    value_type: 'string', default_value_json: '0 3 * * *',
    description: 'Cron expression for automatic Night Audit (per property).'
  });
  registerSpec('night_audit', 'timezone', {
    value_type: 'string', default_value_json: 'UTC',
    description: 'IANA timezone for the Night Audit cron (per property).'
  });
  registerSpec('night_audit', 'stale_threshold_hours', {
    value_type: 'int', default_value_json: 24, min: 1, max: 168,
    description: 'Emit business_date.stale_detected when the property current_business_date is older than this many hours.'
  });
  registerSpec('night_audit', 'auto_scheduler_enabled', {
    value_type: 'boolean', default_value_json: true,
    description: 'Master switch for the per-property recurring Night Audit job.'
  });

  // ---- pms --------------------------------------------------------------
  registerSpec('pms', 'default_meal_plan_id', {
    value_type: 'string', default_value_json: null,
    description: 'Default meal_plan_id assigned to new rate plans for this property.'
  });
  registerSpec('pms', 'default_currency', {
    value_type: 'string', default_value_json: 'LKR',
    description: 'Default currency for new rate plans / folios in this property.'
  });

  // ---- folio (Phase 7 reserved) ----------------------------------------
  registerSpec('folio', 'payment.auto_allocate_oldest_first', {
    value_type: 'boolean', default_value_json: true,
    description: 'When true, incoming payments are auto-distributed against the oldest open charge lines first.'
  });
  registerSpec('folio', 'numbering.format', {
    value_type: 'string', default_value_json: '{PROPCODE}-F-{YYYY}-{NNNNNN}',
    description: 'Folio number format template. Tokens: {PROPCODE}, {YYYY}, {NNNNNN}.'
  });

  // ---- invoices (Phase 7 / C9) -----------------------------------------
  registerSpec('invoice', 'numbering.format', {
    value_type: 'string', default_value_json: '{PROPCODE}-INV-{YYYY}-{NNNNNN}',
    description: 'Invoice number format template. Tokens: {PROPCODE}, {YYYY}, {NNNNNN}.'
  });
  registerSpec('invoice', 'allow_void_after_days', {
    value_type: 'int', default_value_json: 7, min: 0, max: 365,
    description: 'Days after issuance that an invoice may still be voided.'
  });

  // ---- vouchers (Phase 7 / C6) -----------------------------------------
  registerSpec('vouchers', 'default_validity_days', {
    value_type: 'int', default_value_json: 90, min: 1, max: 730,
    description: 'Days past departure_date that an unredeemed voucher remains valid.'
  });

  // ---- allocations (Phase 7 / C7) --------------------------------------
  registerSpec('allocations', 'default_release_days', {
    value_type: 'int', default_value_json: 7, min: 0, max: 90,
    description: 'Default number of days before arrival that an unconsumed allocation is auto-released.'
  });

  // ---- reservation groups (Phase 7 / C5) --------------------------------
  registerSpec('pms', 'groups.auto_block_inventory', {
    value_type: 'boolean', default_value_json: true,
    description: 'When true, creating a reservation group automatically blocks inventory for its date range.'
  });
  registerSpec('pms', 'groups.cancel_requires_force_when_checked_in', {
    value_type: 'boolean', default_value_json: true,
    description: 'When true, cancel-all on a group with any CHECKED_IN member requires the explicit `force=true` flag.'
  });

  // ---- folio cash payments (Phase 7 / C10) -----------------------------
  registerSpec('payment', 'cash.rounding_unit', {
    value_type: 'number', default_value_json: 0.01,
    description: 'Rounding unit for cash change calculation (e.g. 0.01, 1.00 for whole-unit currencies).'
  });

  // ---- finance (Phase 8 reserved) --------------------------------------
  registerSpec('finance', 'cost_center.required_on_expense', {
    value_type: 'boolean', default_value_json: false,
    description: 'When true, any expense journal entry must carry a cost_center_id.'
  });
  registerSpec('finance', 'deferred_revenue.recognize_on', {
    value_type: 'enum', enum_values: ['night_audit','checkout','manual'],
    default_value_json: 'night_audit',
    description: 'When advance deposits are recognised as revenue.'
  });

  // ---- channel manager (Phase 9 reserved) -------------------------------
  registerSpec('channel_manager', 'sync.frequency_minutes', {
    value_type: 'int', default_value_json: 15, min: 1, max: 1440,
    description: 'How often the channel sync job runs per property.'
  });

  // ---- reputation (Phase 13 reserved) ----------------------------------
  registerSpec('reputation', 'import.cron', {
    value_type: 'string', default_value_json: '0 */6 * * *',
    description: 'Cron expression for the periodic review import job.'
  });

  // ---- mobile_access ----------------------------------------------------
  registerSpec('mobile_access', 'key.default_validity_hours', {
    value_type: 'int', default_value_json: 48, min: 1, max: 720,
    description: 'Default validity window (hours) for issued mobile access keys.'
  });

  // ---- ai ---------------------------------------------------------------
  registerSpec('ai', 'default_provider', {
    value_type: 'enum', enum_values: ['anthropic','openai','gemini'],
    default_value_json: 'anthropic',
    description: 'Default LLM provider for AI features. MUST be a real, configured provider (no mocks).'
  });
  registerSpec('ai', 'budget_usd_monthly', {
    value_type: 'number', default_value_json: 0,
    description: 'Monthly AI spend cap in USD. 0 disables the cap.'
  });
}

module.exports = { bootstrapSettingsCatalog };

#!/usr/bin/env node
'use strict';

/**
 * Phase 4: brief-mandated alias for the localStorage user migration tool.
 * Idempotent. Delegates to migrate-gk-users.js which is the canonical
 * implementation (Phase 2). Same CLI flags.
 *
 * Usage:
 *   node src/scripts/migrate-local-users.js --tenant-code <code> --input <path>
 */

require('./migrate-gk-users');

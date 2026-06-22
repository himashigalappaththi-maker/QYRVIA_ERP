'use strict';

/**
 * Command template. Copy to a real filename like `reservation.create.js`,
 * fill in the name/handler, and register at boot:
 *
 *   commandBus.register(require('./reservation.create'));
 *
 * See commands/README.md for the contract.
 */

const { makeEvent } = require('../core/event');

module.exports = {
  // <aggregate>.<verb>  - lowercase snake_case, single dot
  name: 'aggregate.action',

  // Aggregate this command mutates. Drives the event aggregate_type field.
  aggregateType: 'aggregate',

  // Phase 3+: schema reference for validating `input`. Leave undefined for now.
  inputSchema: undefined,

  /**
   * @param {object} input - command payload (already-parsed JSON body)
   * @param {object} ctx   - { tenantId, propertyId, requestId, actorId }
   * @returns {Promise<{ok, result?, events?, error?, detail?}>}
   */
  async handler(input, ctx) {
    // TODO 1. validate input
    // TODO 2. check permission (ctx.actorId vs RBAC matrix)
    // TODO 3. apply business rule (db.withTenant(ctx.tenantId, async client => ...))
    // TODO 4. compose events to publish on success

    // Placeholder while template is unmodified - prevents accidental success:
    return {
      ok: false,
      error: 'template_command_not_implemented',
      detail: 'Copy commands/_template.js, set name + handler, register with commandBus.'
    };

    // Successful example (delete the placeholder above when implementing):
    // return {
    //   ok: true,
    //   result: { aggregateId: 'new-id' },
    //   events: [
    //     makeEvent({
    //       type:          'aggregate.created',
    //       aggregateType: 'aggregate',
    //       aggregateId:   'new-id',
    //       payload:       { ... },
    //       ctx
    //     })
    //   ]
    // };
  }
};

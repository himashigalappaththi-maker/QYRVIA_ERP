'use strict';

/**
 * InventoryService - validates + normalizes availability into
 * CanonicalInventory. OTA-agnostic home for availability business rules.
 */

const { makeCanonicalInventory, inventoryKey } = require('../core/canonical/CanonicalInventory');

function buildInventoryService() {
  return {
    validate(fields) {
      return makeCanonicalInventory(fields);
    },
    key: inventoryKey
  };
}

module.exports = { buildInventoryService };

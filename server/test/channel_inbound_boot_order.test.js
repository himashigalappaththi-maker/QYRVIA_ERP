'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('channel inbound is constructed after ARI service initialization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const ariReady = source.indexOf("ariService = buildAriService({ store: ariDbStore })");
  const inboundBuild = source.indexOf('channelInbound = buildChannelInbound({');

  assert.notEqual(ariReady, -1, 'ARI service initialization must exist');
  assert.notEqual(inboundBuild, -1, 'channel inbound initialization must exist');
  assert.ok(
    ariReady < inboundBuild,
    'channel inbound must be built after ARI so OTA availability cannot be silently disabled'
  );
  assert.match(
    source.slice(ariReady, inboundBuild + 500),
    /availabilityProvider:\s*inboundAvailabilityProvider/,
    'the initialized ARI availability provider must be injected into channel inbound'
  );
});

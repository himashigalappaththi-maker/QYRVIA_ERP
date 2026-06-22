# QYRVIA Phase 10.2 — OTA Scaling System (50+ OTA Architecture)

> Goal: support 50+ OTA integrations where **one OTA = one adapter file**, with
> **no changes** to the Channel Manager core, the sync engine, QTCN (Phase
> 10.1), or the database schema. Additive and CI-safe.

## Core principle — "One OTA = One Adapter File"

Adding an OTA is dropping a single file in `adapters/otas/`. The registry
discovers it from the filesystem; nothing else changes — no registry edit, no
core branching, no sync-engine change, no migration.

## Architecture (all NEW, additive — existing 10.0/10.1 files untouched)

```
channel-manager/
  adapters/
    base/
      OTAAdapter.js        (Phase 10.0 contract - UNCHANGED)
      assertAdapter.js     (Phase 10.2: new 5-method base + assertAdapter())
    otas/
      booking.com.adapter.js   agoda.adapter.js   expedia.adapter.js
      airbnb.adapter.js        makemytrip.adapter.js
      googletravel.adapter.js  tripadvisor.adapter.js
      qytn.adapter.js          (QTCN as a normal OTA)
  registry/
    adapterRegistry.js     (filesystem auto-discovery; single source of truth)
    adapterFactory.js      (dynamic, lazy instantiation + validation + cache)
```

> The brief also lists `core/syncEngine.js` + `core/queueManager.js`. These
> **already exist** as `core/sync/SyncEngine.js` + `core/sync/QueueManager.js`
> (Phase 10.0) and the constraints forbid changing the sync engine, so they are
> **reused unchanged**. The 10.2 adapters' `pushRates`/`pushInventory` are
> compatible with that engine; no duplicate engine was created.

## Adapter contract (strict)

```
class OTAAdapter {
  async pullAvailability(query)  // -> normalized availability[]
  async pushRates(rate)          // -> normalized ack
  async pushInventory(inv)       // -> normalized ack
  async createBooking(req)       // -> normalized booking
  async cancelBooking(id)        // -> normalized booking (CANCELLED)
}
```

Every method is **async**, returns a **normalized canonical shape**, and
**never touches the DB**. The base class (`base/assertAdapter.js`) supplies
working, channel-keyed mock implementations, so each adapter file only declares
its identity (channel + commission). `assertAdapter(adapter)` validates the
contract (presence + async-ness) and is enforced by the factory at load time.

## Registry + factory

- **`adapterRegistry.js`** — `discover()` lists `*.adapter.js` from `otas/`;
  `list()`, `has()`, `get(name)`, `all()`, `validateAll()`. The registry is the
  ONLY thing that decides which adapters exist. No OTA name is hardcoded in
  business logic.
- **`adapterFactory.js`** — `create(name)` lazily `require`s the adapter module,
  instantiates `module.exports.Adapter`, validates it against the contract, and
  caches the instance. Unknown names throw `unknown_ota_adapter`.

## QTCN rule (honored)

`qytn.adapter.js` extends the same base, exposes the same five methods, flows
through the same registry/factory, and has **no privileged logic and no
bypass**. The test `QTCN exposes exactly the same method surface as an external
OTA` proves it adds no methods beyond the shared base; the booking-flow test
proves Booking.com and QTCN return identical result shapes (the only difference
is data: QTCN is zero-commission). QTCN is just another OTA in the registry.

## Adding the 50th OTA (the whole point)

1. Create `adapters/otas/<name>.adapter.js`:
   ```js
   const { OTAAdapter } = require('../base/assertAdapter');
   class XAdapter extends OTAAdapter { constructor() { super('<name>', { commissionPct: 13 }); } }
   module.exports = { channel: '<name>', Adapter: XAdapter };
   ```
2. That's it. `registry.list()` includes it automatically; `registry.get('<name>')`
   returns a validated instance. No core/sync/QTCN/DB change.

## Tests (`test/ota_scale.test.js`)

- Registry auto-discovers all adapters (incl. `qytn`).
- Every adapter passes the 5-method async contract (`validateAll()`).
- `get()` returns instances; unknown name throws; factory caches (lazy).
- Mock booking flow identical for Booking.com vs QTCN (create/cancel/availability/push).
- QTCN exposes exactly the shared method surface (no privilege/bypass).

## CI constraints (met)

- JavaScript / CommonJS; passes Node 22 + Postgres 16 CI.
- Existing Phase 9.1 + 10.0 + 10.1 tests unchanged (purely additive).
- No schema migrations; no breaking changes to the Channel Manager core.

## Final state

The system supports 50+ OTAs without core modification; adding an OTA is a
drop-in adapter file; QTCN behaves exactly like any external OTA; the Channel
Manager remains the unchanged execution engine.

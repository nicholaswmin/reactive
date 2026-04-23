# Contributing

## Structure

Source:

```text
src/
├── index.js
│   re-exports Reactive
├── internals.js
│   WeakMaps, constants, storeFor, liveFor
├── identity.js
│   IdentifiedList, ITEM_ID, item-id helpers
├── path.js
│   pathKey, valueAtPath, setAtPath, resolvePathExists
├── version.js
│   Lamport clock, compare, ancestor/descendant checks
├── serialize.js
│   clone, serializeValue, versionsFrom
├── snapshot.js
│   snapshot build, merge, cache, trim
└── reactive.js
    Proxy traps, hydrate, delta emit/apply, Reactive class
```

Docs:

```text
docs/
└── spec.md
    behavioural spec
```

Tests:

```text
test/
├── identity.test.js
│   (type, id) keying, instance reuse, instanceof
├── model.test.js
│   local and replicated model sequences
├── mutation.test.js
│   local reads, nested writes, deletes, arrays
├── sync.test.js
│   sync lifecycle, replication, conflict, arrays
├── refs.test.js
│   nested Reactive serialization and hydration
├── deep.test.js
│   IdentifiedList granular deltas and convergence
└── utils/
    ├── bus/index.js
    │   linked in-memory transport for replication tests
    ├── context/index.js
    │   per-test Reactive subclass factories
    └── prop/index.js
        seeded property-test helper for model tests
```

## Model

- Single export, split across modules.
- All mutable state is in module-scoped `WeakMap`s.
- Live objects are `Proxy`s intercepting get/set/delete.
- Identity is `(type, id)`.
- Same pair in one context always returns the same proxy.
- Writes are local-first.
- Remote writes apply in place.
- Remote writes never echo.
- Versioning is per property path.
- Snapshots are used for hydration and repair.
- Nested `Reactive` values serialize as typed refs.
- `$ref` and `$iid` are reserved wire keys.

```js
const a = new User('u1', { name: 'A' })
const b = new User('u1')

a === b
```

## Transport

Contract:

- `send(event, payload)`
- `on(event, handler)`

Wire events:

- `reactive:delta`
- `reactive:snapshot:request`
- `reactive:snapshot:response`

Behavior:

- `on()` may return a cleanup function.
- The runtime assumes ordered, reliable delivery.
- Rebinding tears down previous subscriptions first.
- Local writes emit deltas with `class`, `id`, `path`, and `version`.
- Inbound deltas update the live instance in place.
- Inbound deltas do not echo.
- Unknown inbound ids may materialize incomplete local shells.

```json
{
  "class": "User",
  "id": "u1",
  "path": ["items", "abc-uuid", "name"],
  "value": "updated",
  "version": { "tick": 5, "context": "ctx-1" }
}
```

## Arrays

- Arrays of plain objects use stable per-item identity.
- Item field edits produce granular deltas.
- Structural changes replicate as whole-list sets.
- Other arrays use version-gated ops.
- Nested edits and index writes fall back to a whole-array set.
- Promotion happens in `clone` and `hydrate`.
- Promotion requires a non-empty plain-object array.
- Empty arrays stay plain.
- First push uses boundary fallback.
- Concurrent item edits to different items both survive.
- Concurrent structural changes converge to one LWW array.
- Deltas targeting removed items trigger repair.

```js
user.items[0].name = 'x'
// path: ['items', uuid, 'name']

user.tags.push('x')
// op: 'push', path: ['tags']
```

## Sync

- `sync(id)` returns the existing local instance only when complete and
  authoritative.
- Otherwise it uses a complete authoritative cached snapshot when
  available.
- Otherwise it sends a snapshot request with a `requestId`.
- Only the matching snapshot response resolves the pending `sync(id)`.
- Deltas do not satisfy `sync(id)` on their own.
- Missing responses are non-authoritative in multi-peer transports.
- If no matching snapshot arrives, a matching missing response rejects
  `sync(id)`.
- Requests time out when no authoritative response arrives.

## Tests

Run:

```sh
npm test
npm run test:cov
npm run test:mut -- --dryRunOnly
```

Fixtures:

- `createContext()` for local behavior
- `createLinkedContexts()` for ordinary replication
- `Bus.createPair()` only for exact transport control

Guidelines:

- Add the smallest repro first.
- Keep tests behavior-based and refactor-resistant.
- Test ids are short and descriptive.
- No prefixes.
- Use `t.assert.*` strict assertions.
- Do not add custom assertion messages to ordinary assertions.
- `await Bus.flush()` settles pending async delivery.
- Treat each `Bus.flush()` as one transport turn.
- Use two flushes only when the protocol needs a second turn.
- Prefer explicit promises and transport turns when they read better.
- Use the narrowest assertion that matches the contract.
- Find the bus message.
- Assert it exists.
- Then inspect `.payload`.
- Keep tests symmetrical.

Model tests:

- `test/model.test.js` uses a plain-object model as the oracle.
- `test/utils/prop/index.js` provides the seeded `Generator`.
- `Generator.Assertions()` installs model assertions.
- Use `t.assert.models(actual, expected, info)` for generated
  state checks.
- Pass `seed`, `step`, `command`, and `side` when they apply.
  That context belongs in the registered assertion, not in ad hoc
  assertion messages.
- Do not add a fuzzing dependency or shrinker unless the test failure
  workflow proves it is needed.

Cover at minimum:

- local mutation
- one-way replication
- both directions
- stale or duplicate delivery
- snapshot repair
- arrays, if arrays are touched

## Code style

- Zero deps.
- No build.
- No TypeScript.
- ESM only.
- Node `>=24`.
- Use `const fn =` for module-level functions.
- Classes only for `Reactive` and `IdentifiedList`.
- No comments unless the logic is non-obvious.
- No docstrings.
- No type annotations.
- Keep `README.md` and `docs/spec.md` in sync with behavior.

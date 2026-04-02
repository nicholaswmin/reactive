# Contributing

## Structure

Where each thing goes:

```
src/
├── index.js          re-exports Reactive
├── internals.js      WeakMaps, constants, storeFor, liveFor
├── identity.js       IdentifiedList, ITEM_ID, item-id helpers
├── path.js           pathKey, valueAtPath, setAtPath, resolvePathExists
├── version.js        Lamport clock, compare, ancestor/descendant checks
├── serialize.js      clone, serializeValue, versionsFrom
├── snapshot.js       snapshot build, merge, cache, trim
└── reactive.js       Proxy traps, hydrate, delta emit/apply, Reactive class
docs/
└── spec.md           behavioural spec
test/
├── identity.test.js  (type, id) keying, instance reuse, instanceof
├── mutation.test.js  local reads, nested writes, deletes, arrays
├── sync.test.js      sync lifecycle, replication, conflict, arrays
├── refs.test.js      nested Reactive serialization and hydration
└── deep.test.js      IdentifiedList granular deltas and convergence
```

## Architecture

- Single export, split across modules. All mutable state is in module-scoped `WeakMap`s.
- Live objects are `Proxy`s intercepting get/set/delete to track paths and emit deltas.
- Identity is `(type, id)`. Same pair in one context always returns the same proxy.
- Writes are local-first: mutate then replicate. Remote writes apply in place, never echo.
- Versioning is per property path, not per object. Lamport clock with UUID tiebreak for LWW.
- Snapshots are the repair path when deltas cant apply. Correctness machinery, not convenience.
- `$ref` and `$iid` are reserved wire keys. Don't use them as property names.

```js
const a = new User('u1', { name: 'A' })
const b = new User('u1')

a === b // always true within one context
```

## Replication

- Three wire events: `reactive:delta`, `reactive:snapshot:request`, `reactive:snapshot:response`.
- Deltas carry `class`, `id`, `path`, `value`, `version`. Array ops add `op`, `args`, `baseVersion`.
- Bus contract is `send(event, payload)` and `on(event, handler)`. Assumes ordered reliable delivery.
- Inbound sets check ancestor/descendant version ordering. Stale deltas are silently dropped.
- When a delta targets a path that no longer resolves, the runtime requests snapshot repair.
- `toJSON` omits internal identity (`$iid`); deltas and snapshots include it.

```json
{
  "class": "User", "id": "u1",
  "path": ["items", "abc-uuid", "name"],
  "value": "updated",
  "version": { "tick": 5, "context": "ctx-1" }
}
```

## Arrays

- Arrays of plain objects promote to `IdentifiedList`. Each item gets a non-enumerable `Symbol` UUID.
- Item field edits produce granular deltas by UUID. Structural mutations emit whole-list sets.
- Promotion happens in `clone` and `hydrate` when all elements are plain objects and non-empty.
- Empty arrays stay plain. First push uses boundary fallback, promotion happens via snapshot.
- Plain arrays (primitives, mixed) use boundary: first ancestor array is the replication unit.
- Concurrent item edits to different items both survive. Structural changes converge via LWW.
- Deltas targeting removed items get rejected via `resolvePathExists` and trigger repair.

```js
user.items[0].name = 'x'
// path: ['items', uuid, 'name'] — stable across splices

user.tags.push('x')
// op: 'push', path: ['tags'] — version-gated replay
```

## Testing

- `npm test`. No build step, no dependencies.
- `createLinkedContexts()` for two-context replication, `createContext()` for local tests.
- `await Bus.flush()` settles pending async delivery. Always flush before asserting remote state.
- Test IDs are short and descriptive: `'conflict'`, `'echo'`, `'fwd'`. No prefixes.
- No custom assertion messages. The test name is the message.
- For every protocol change, cover at minimum:
  - local mutation
  - one-way replication (source to remote)
  - both directions
  - stale or duplicate delivery
  - snapshot repair
- Keep tests symmetrical. If it only works in one direction its not done.
- Most bugs surface under races, drops, or stale snapshots. Happy-path alone isnt enough.

```js
const { a, b } = createLinkedContexts()
const left = new a.User('fwd', { name: 'A' })
const right = await b.User.sync('fwd')

left.name = 'B'
await Bus.flush()

t.assert.equal(right.name, 'B')
```

## Code style

- Zero deps. No build. No TypeScript. ESM only. Node >= 24.
- `const fn =` for module-level functions. Classes only for `Reactive` and `IdentifiedList`.
- No comments unless the logic is non-obvious. No docstrings, no type annotations.
- Keep `README.md` and `docs/spec.md` in sync with actual behavior.

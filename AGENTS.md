# AGENTS

This library constructs replicated models with native ergonomics and
efficient updates.

It is not a full CRDT.
It uses identity, path versions, LWW conflict resolution, and snapshot
repair to handle the replication cases this runtime supports.

- Replication tolerates momentary connection drops.
  Reconnect must not corrupt data.
- Offline actions during a dropped connection may be discarded.
- Reads are local-first.
  A local write must be readable immediately.
- Updates stay efficient, including deep array mutation.
- Models keep native ergonomics.
  Implementation details stay hidden.
- Supported data includes at least `String`, `Number`, `Boolean`,
  `Array`, and `Object`.
- Memory/resource increase is not bounded by operation count.
- Testing quality is a strict non-functional requirement.
  The suite must be kept to the highest standard, in line with the
  [testing guide][test-guide].

## Issues

- `src/snapshot.js`: preserve descendant versions when a snapshot
  subtree wins.
- `src/reactive.js`: normalize local array mode after whole-list writes.
- `src/reactive.js`: reassign item ids after `fill()` and `copyWithin()`
  duplicate list entries.
- `src/reactive.js`: reject sparse arrays before IdentifiedList promotion.
- `README.md`: avoid constructor examples that mutate reused instances.

## Workflow

- Read the whole repo before changing behavior.
  The library is small enough to fit many times over.
- Treat disagreements between docs, tests, and runtime as design
  problems.
- Add the smallest repro first.
  Most bugs here are easier to prove than to reason about.
- Match existing structure, style, and test idioms.
  Do not add abstractions unless they remove real complexity.
- Prefer explicit fallback over clever merge logic.
  Full sync is acceptable when a delta path is no longer trustworthy.
- For protocol work, define path, precondition, and fallback before
  implementation.
- Keep README and this file honest.
  Do not describe guarantees the runtime does not provide.

> [!IMPORTANT]
> Execute workflow rules with intent.
> Always think about the item at hand and adapt accordingly.
> Generalize the idiom; do not repeat unusual examples mechanically.
> Extract the underlying pattern and apply it where it fits.
> Spend time at the end double-checking all aspects of the work.

## Runtime Contract

### Priorities

- Preserve identity first.
  One live instance per `(type, id)` in one context is the core model.
- Preserve local-first reads.
  Mutations apply locally before replication.
- Preserve deterministic convergence.
  Remote delivery may be delayed, but equal inputs must settle the same
  way.
- Treat the wire contract as public API.
  Renames, routing changes, and payload shape changes are protocol work.

```js
class User extends Reactive {}

const a = new User('u1', { name: 'A' })
const b = new User('u1')

a === b // true
```

### Identity and refs

- Identity is keyed by `(type, id)`, not by object shape.
- `static type` is the stable wire id when present.
- If `static type` is omitted, the wire id falls back to `Ctor.name`.
- Wire payloads carry the record type id in a `class` field.
- Reconstructing the same `(type, id)` returns the same live instance
  within a context.
- Different types may reuse the same `id` without colliding.
- Duplicate explicit types on the same bus are rejected.
- `instanceof` survives proxying for both the subclass and `Reactive`.
- Nested `Reactive` values serialize as `{ $ref, id }`.
- Child mutations replicate under the child id, not the parent id.
- Removing a nested ref from a parent does not remove the child identity.
- Reactive reference cycles serialize without infinite recursion.
- Snapshot hydration restores reachable refs as live instances.
- Cache-backed sync rebuilds reachable refs only from complete
  authoritative per-record snapshots registered locally.

### Local state

- Primitive writes are readable immediately.
- Nested plain objects stay live through proxied access.
- Deletes remove the property on the next read.
- Array push, splice, index writes, and length truncation stay live.
- Self-returning array mutators return the proxied array.
- Stale nested aliases throw on write after an ancestor replacement.
- `Object.keys()`, spread, and `JSON.stringify()` work against the
  proxied instance.
- `id` is non-enumerable and only appears in `toJSON()`.

### Transport

- The bus contract is:
  - `send(event, payload)`
  - `on(event, handler)`
- `on()` may return a cleanup function.
- The runtime assumes ordered, reliable delivery.
- The runtime subscribes to:
  - `reactive:delta`
  - `reactive:snapshot:request`
  - `reactive:snapshot:response`
- Rebinding tears down previous subscriptions first.
- Local writes emit deltas with `class`, `id`, `path`, and `version`.
- Inbound deltas update the live instance in place and do not echo.
- Unknown inbound ids may materialize incomplete local shells.

```js
User.use(bus)
bus.send('reactive:delta', payload)
```

### Replication

- Versions use a Lamport clock.
- Each context has its own stable context id.
- Later Lamport ticks win.
- Equal Lamport ticks use the context id as deterministic tiebreak.
- LWW applies per property path.
- Plain object paths are the safest unit of change.
- Path semantics must stay stable.
  A write to `address.city` stays about that path.
- Ancestor and descendant writes need deterministic ordering.
  Older ancestors must not clobber newer leaves.
- Snapshot application is version-aware.
  Older snapshot fields must not overwrite newer local paths.
- When a snapshot subtree wins, descendant versions in that subtree must
  survive in the merged version map.

### Arrays

- Arrays are the sharp edge.
- Do not assume CRDT semantics.
- Treat array structure as a conflict boundary unless a narrower rule is
  explicitly defined.
- IdentifiedList applies to dense, non-empty arrays of plain objects.
  Sparse or mixed arrays must not promote to IdentifiedList.
- IdentifiedList item field paths use `[arrayKey, itemUUID, fieldKey]`.
- The item precondition is that the item must exist in the list.
- The fallback for missing items is snapshot repair.
- Item field edits produce granular deltas addressed by item UUID.
- Structural changes to identified lists emit whole-list LWW sets.
- Item identity is a non-enumerable Symbol, invisible to user code.
- Item identity travels on the wire as `$iid`, a reserved key like `$ref`.
- Other array mutators emit `op`, `args`, and `baseVersion`.
- Array ops apply only when the current array version matches
  `baseVersion`.
- When that precondition fails, the runtime requests snapshot repair.
- Nested edits and index writes fall back to a whole-array `set`.
- Deltas targeting removed IdentifiedList items are rejected and trigger
  repair.
- Concurrent item field edits to different items both survive.
- Concurrent structural changes to the same array converge to one LWW
  array.
- Be careful with mutators that return the array itself.
  Returning a raw array leaks local writes around replication.

### Sync and repair

- `sync(id)` returns an existing local instance only when that record is
  complete and authoritative.
- Otherwise it uses a complete authoritative cached snapshot when one is
  available.
- Otherwise it sends a snapshot request with a `requestId`.
- Only a matching `class`, `id`, and `requestId` snapshot response
  resolves the pending `sync(id)`.
- Unsolicited, foreign-class, and mismatched-request responses do not
  hydrate pending syncs.
- Deltas never satisfy `sync(id)` on their own.
- Missing responses are non-authoritative in multi-peer transports.
- If no matching authoritative snapshot arrives, a matching missing
  response rejects `sync(id)`.
- Requests time out when no authoritative response arrives.
- Snapshot responses include the complete authoritative nested snapshots
  needed to hydrate reachable refs.
- Repair marks the local record non-authoritative until a matching
  authoritative snapshot is applied.
- Unknown ids should fail clearly when they cannot be repaired.
  Hanging forever is not a useful contract.

### Memory and offline

- Snapshot caches are bounded per class store.
- Pending `sync(id)` requests are deduplicated per id and time out.
- The runtime keeps in-memory snapshots only.
- Offline mutations are local-first in memory, but not durable.
- There is no durable outbox, retry journal, or CRDT merge layer.
- For future offline or reconnect work, think in two stores:
  - durable local snapshots
  - durable outbound journal

## Definition of Done

### Tests

- Treat `.github/CONTRIBUTING.md` as the canonical testing guide.
- Run:

```sh
npm test
npm run test:cov
npm run test:mut -- --dryRunOnly
```

- Behavior changes must be covered by `node:test` tests using existing
  fixtures.
- Protocol changes must cover:
  - local behavior
  - one-way replication
  - both directions
  - stale or duplicate delivery
  - snapshot repair
  - arrays, if arrays are touched
- Use `t.assert.*` strict assertions.
- Do not add custom assertion messages to ordinary assertions.
- Keep tests symmetrical when possible.
  A change that only works source-to-remote is not done.
- Model tests compare live `Reactive` state against a plain-object model
  with `t.assert.models(...)`.
- `test/model.test.js` installs that assertion with
  `Generator.Assertions()`.
- Pass `seed`, `step`, `command`, and `side` context where useful.
  That context belongs in the registered assertion, not in ad hoc
  assertion messages.
- Do not add a fuzzing dependency, shrinker, or generic property-test
  framework unless there is concrete evidence the current seeded model
  tests are not debuggable enough.

### Documentation

- README stays minimal and user-facing.
- This file is the maintainer runtime contract.

## Gotchas

- Proxy aliases can go stale after ancestor replacement.
  Old nested references may no longer point at current state.
- Unknown inbound deltas can create incomplete local shells.
- Array replay is more fragile than plain object path replay.
- Any behavior that falls back to `Ctor.name` is sensitive to renames
  and duplicate class names.
- A passing happy-path suite is not enough here.
  Most mistakes show up under races, drops, stale snapshots, or partial
  hydration.

[test-guide]: ./.github/CONTRIBUTING.md

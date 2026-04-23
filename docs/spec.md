# Reactive

Implementation spec for the current runtime.

## Identity

- Identity is keyed by `(type, id)`.
- `static type` is the stable wire id when present.
- If `static type` is omitted, the wire id falls back to `Ctor.name`.
- Wire payloads currently carry that type id in a `class` field.
- Reconstructing the same `(type, id)` returns the same live instance
  within a context.
- Different types may reuse the same `id` without colliding.
- Duplicate explicit types on the same bus are rejected.
- `instanceof` survives proxying for both the subclass and `Reactive`.

## Local state

- Primitive writes are readable immediately.
- Nested plain objects stay live through proxied access.
- Deletes remove the property on the next read.
- Array push, splice, index writes, and length truncation stay live.
- Self-returning array mutators return the proxied array.
- Stale nested aliases throw on write after an ancestor replacement.
- `Object.keys()`, spread, and `JSON.stringify()` work against the
  proxied instance.
- `id` is non-enumerable and only appears in `toJSON()`.

## Replication

- `use(bus)` binds one ordered, reliable transport per class.
- The runtime subscribes to:
  - `reactive:delta`
  - `reactive:snapshot:request`
  - `reactive:snapshot:response`
- Rebinding tears down the previous subscriptions first.
- Local writes emit deltas with `class`, `id`, `path`, and `version`.
  The `class` field is the wire name for the record type id.
- Arrays of plain objects use stable per-item identity (IdentifiedList).
  Item field edits produce granular deltas addressed by item UUID.
  Structural mutations emit a whole-list `set` with item identities.
  Item identity is a non-enumerable Symbol, invisible to user code.
  Identity travels on the wire as `$iid`, a reserved key like `$ref`.
- Other array mutators emit `op`, `args`, and `baseVersion`.
  Nested edits and index writes fall back to a whole-array `set`.
- Inbound deltas update the live instance in place and do not echo.
- Unknown inbound ids may materialize incomplete local shells.

## Conflict resolution

- Versions use a Lamport clock.
- Each context has its own stable context id.
- Later Lamport ticks win.
- Equal Lamport ticks use the context id as a deterministic tiebreak.
- LWW applies per property path.
- A newer nested write blocks an older ancestor write from clobbering it.
- Snapshot application is version-aware and does not let older snapshot
  fields overwrite newer local paths.
- Array ops apply only when the current array version matches
  `baseVersion`.
- When that precondition fails, the runtime requests a snapshot repair.
- Deltas targeting removed IdentifiedList items are rejected and trigger
  repair.
- Concurrent item field edits to different items in the same list both
  survive.
- Concurrent structural changes to the same array converge to one LWW
  array.

## Sync

- `sync(id)` returns the existing local instance only when that record is
  complete and authoritative.
- Otherwise it uses a complete authoritative cached snapshot when one is
  available.
- Otherwise it sends a snapshot request with a `requestId`.
- Only the matching snapshot response resolves the pending `sync(id)`.
- Deltas never satisfy `sync(id)` on their own.
- Missing responses are non-authoritative in multi-peer transports.
- If no matching snapshot arrives, a matching missing response rejects
  `sync(id)`.
- Requests time out when no authoritative response arrives.

## Nested Reactives

- Nested `Reactive` values serialize as `{ $ref, id }`.
- Snapshot responses include the complete authoritative nested snapshots
  needed to hydrate those refs as live instances.
- Child mutations replicate under the child id, not the parent id.
- Removing a nested ref from a parent does not remove the child from the
  identity map.
- Reactive reference cycles serialize without infinite recursion.
- Cache-backed sync rebuilds reachable refs from complete authoritative
  per-record snapshots when their types are registered locally.

## Memory and offline

- Snapshot caches are bounded per class store.
- Pending `sync(id)` requests are deduplicated per id and time out.
- The runtime keeps in-memory snapshots only.
- Offline mutations are local-first in memory, but not durable.
- There is no durable outbox, retry journal, or CRDT merge layer.

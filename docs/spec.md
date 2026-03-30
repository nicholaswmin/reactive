# Reactive

Implementation spec for the current runtime.

## Identity

- Explicit constructor ids are preserved.
- Missing constructor ids are generated with `randomUUID()`.
- Reconstructing the same `(class, id)` returns the same live instance
  within a context.
- Different classes may reuse the same id without colliding.
- `instanceof` survives proxying for both the subclass and `Reactive`.

## Local state

- Primitive writes are readable immediately.
- Nested plain objects stay live through proxied access.
- Deletes remove the property on the next read.
- Array push, splice, index writes, and length truncation stay live.
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
- Inbound deltas update the live instance in place and do not echo.
- Unknown inbound ids are materialized locally on first delta.

## Conflict resolution

- Versions use a Lamport clock.
- Each context has its own stable context id.
- Later Lamport ticks win.
- Equal Lamport ticks use the context id as a deterministic tiebreak.
- LWW applies per property path.
- A newer nested write blocks an older ancestor write from clobbering it.

## Sync

- `sync(id)` returns the existing local instance when available.
- Otherwise it sends a snapshot request and resolves on response.
- If no live instance exists but a snapshot is cached locally,
  `sync(id)` hydrates from that snapshot.
- `sync(id)` throws when the id is unknown and no bus is configured.

## Nested Reactives

- Nested `Reactive` values serialize as `{ $ref, id }`.
- Snapshot responses include the reachable nested snapshots needed to
  hydrate those refs as live instances.
- Child mutations replicate under the child id, not the parent id.
- Removing a nested ref from a parent does not remove the child from the
  identity map.
- Reactive reference cycles serialize without infinite recursion.

## Arrays

- Local array mutation stays live through the proxied array instance.
- Replication uses the array property's current serialized value.
- Concurrent edits to the same array use array-property LWW.
- This implementation does not provide per-element merge semantics.

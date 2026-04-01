# reactive

Replicated domain objects for isolated JavaScript contexts.

## Model

- One live instance per `(type, id)` in each context
- Immediate local reads after mutation
- Authoritative snapshot sync for remote hydration and repair
- Lamport last-writer-wins per property path
- Nested `Reactive` values serialized as typed refs
- Ordered, reliable bus adapter interface

## Transport

`Reactive` expects a bus with two methods:

- `send(event, payload)`
- `on(event, handler)`

`on()` may return a cleanup function.

## Usage

```js
import { Reactive } from 'reactive'

class User extends Reactive {
  static type = 'app/User@1'
}

User.use(bus)

const john = new User('abc-123', {
  name: 'John',
  address: { city: 'London' },
})
```

```js
import { Reactive } from 'reactive'

class User extends Reactive {
  static type = 'app/User@1'
}

User.use(bus)

const john = await User.sync('abc-123')
john.name // 'John'
```

## Notes

- `sync(id)` returns immediately only for a complete local instance or a
  complete cached snapshot.
- Unknown inbound deltas may auto-create incomplete local shells.
  `sync(id)` still waits for a matching snapshot response or fails.
- `sync(id)` rejects on explicit "missing" responses and times out when
  no authoritative snapshot arrives.
- Arrays of plain objects use stable per-item identity.
  Item field edits produce granular deltas; structural changes
  (push, splice, sort) replicate as whole-list sets.
- Other arrays use version-gated ops for the exact array path.
  Nested edits and index writes fall back to a whole-array set.
- Concurrent item field edits to different items both survive.
  Concurrent structural changes converge to one LWW array.
- If `static type` is omitted, the wire type falls back to the class
  name.

## Test

```sh
npm test
```

See [`docs/spec.md`](./docs/spec.md) for the implementation spec.

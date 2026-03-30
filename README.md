# reactive

Replicated domain objects for isolated JavaScript contexts.

## Model

- One live instance per `(class, id)` in each context
- Immediate local reads after mutation
- Snapshot sync for remote hydration
- Lamport last-writer-wins per property path
- Nested `Reactive` values serialized as refs
- Ordered, reliable bus adapter interface

## Transport

`Reactive` expects a bus with two methods:

- `send(event, payload)`
- `on(event, handler)`

`on()` may return a cleanup function.

## Usage

```js
import { Reactive } from 'reactive'

class User extends Reactive {}

User.use(bus)

const john = new User('abc-123', {
  name: 'John',
  address: { city: 'London' },
})
```

```js
import { Reactive } from 'reactive'

class User extends Reactive {}

User.use(bus)

const john = await User.sync('abc-123')
john.name // 'John'
```

## Notes

- `sync(id)` returns the local instance when it already exists.
- Unknown inbound deltas auto-create the local instance.
- Array writes replicate at the array-property level.
  This implementation does not try to be a CRDT for concurrent
  edits on the same array.

## Test

```sh
npm test
```

See [`docs/spec.md`](./docs/spec.md) for the implementation spec.

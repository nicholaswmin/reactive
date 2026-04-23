[![test][badge]][workflow]

# Reactive

Replicated domain objects

## Model

- One live instance per `(type, id)` in each context
- Immediate local reads after mutation
- Lamport last-writer-wins per property path
- Snapshot sync for hydration and repair
- Nested `Reactive` values serialized as typed refs

## Usage

```js
import { Reactive } from 'reactive'

class User extends Reactive {
  static type = 'app/User@1'

  constructor(id, data) {
    super(id)
    this.name = data.name
    this.address = data.address
  }

  sayHi() {
    console.log(`Hi, I'm ${this.name} from ${this.address.city}!`)
  }
}

User.use(bus)

const john = new User('abc-123', {
  name: 'John',
  address: { city: 'London' },
})
```

In another context:

```js
const john = await User.sync('abc-123')
john.sayHi() // 'Hi, I'm John from London!'
```

## Transport

A bus with `send(event, payload)` and `on(event, handler)`.
`on()` may return a cleanup function.

## Arrays

- Arrays of plain objects use stable per-item identity.
  Item field edits produce granular deltas; structural changes
  replicate as whole-list sets.
- Other arrays use version-gated ops. Nested edits and index writes
  fall back to a whole-array set.
- Concurrent item edits to different items both survive.
  Concurrent structural changes converge to one LWW array.

## Tests

```sh
npm test
npm run test:cov
npm run test:mut -- --dryRunOnly
```

> [!NOTE]
> All changes must include high-signal unit and integration tests,
> structured according to the [contribution guide][cont-guide].

[badge]: https://github.com/nicholaswmin/reactive/actions/workflows/test.yml/badge.svg
[cont-guide]: ./.github/CONTRIBUTING.md
[workflow]: https://github.com/nicholaswmin/reactive/actions/workflows/test.yml

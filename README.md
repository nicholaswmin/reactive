[![test_unit][test-unit-badge]][test-unit-flow]
[![test_mutt][test-mutt-badge]][test-mutt-flow]

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
node --test test/model.test.js
npm test
npm run test:cov
npm run test:mut -- --dryRunOnly
```

> [!NOTE]
> The [contribution guide][cont-guide] is the canonical testing guide.
> It covers fixtures, protocol coverage, assertion style, and model
> tests. `test/model.test.js` explicitly installs
> `Generator.Assertions()` and uses `t.assert.models(...)` for the
> seeded oracle checks.

[test-unit-badge]: https://github.com/nicholaswmin/reactive/actions/workflows/test.yml/badge.svg?label=unit%20tests
[test-unit-flow]: https://github.com/nicholaswmin/reactive/actions/workflows/test.yml
[test-mutt-badge]: https://github.com/nicholaswmin/reactive/actions/workflows/test_mut.yml/badge.svg?label=mutation%20tests
[test-mutt-flow]: https://github.com/nicholaswmin/reactive/actions/workflows/test_mut.yml
[cont-guide]: ./.github/CONTRIBUTING.md

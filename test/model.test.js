import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import {
  createContext,
  createLinkedContexts,
} from './utils/context/index.js'
import { Generator } from './utils/prop/index.js'

Generator.Assertions()

const snapshot = value => JSON.parse(JSON.stringify(value))

const initialState = () => ({
  address: { city: 'London', zip: 'SW1' },
  age: 1,
  name: 'A',
  tags: ['a', 'b'],
  temp: true,
})

const expected = (id, model) => ({ id, ...snapshot(model) })

const commandsFor = (model, gen) => {
  const commands = [
    {
      name: 'set name',
      run: user => {
        const name = gen.names.next().value

        user.name = name
        model.name = name
      },
    },
    {
      name: 'set age',
      run: user => {
        const age = gen.int(90)

        user.age = age
        model.age = age
      },
    },
    {
      name: 'delete age',
      run: user => {
        delete user.age
        delete model.age
      },
    },
    {
      name: 'set temp',
      run: user => {
        const temp = gen.bool()

        user.temp = temp
        model.temp = temp
      },
    },
    {
      name: 'delete temp',
      run: user => {
        delete user.temp
        delete model.temp
      },
    },
    {
      name: 'replace address',
      run: user => {
        const address = {
          city: gen.words.next().value,
          zip: gen.zips.next().value,
        }

        user.address = address
        model.address = address
      },
    },
    {
      name: 'delete address',
      run: user => {
        delete user.address
        delete model.address
      },
    },
    {
      name: 'replace tags',
      run: user => {
        const tags = gen.tags.next().value

        user.tags = tags
        model.tags = tags
      },
    },
  ]

  if (model.address) {
    commands.push({
      name: 'set city',
      run: user => {
        const city = gen.words.next().value

        user.address.city = city
        model.address.city = city
      },
    })
    commands.push({
      name: 'set zip',
      run: user => {
        const zip = gen.zips.next().value

        user.address.zip = zip
        model.address.zip = zip
      },
    })
  }

  if (model.tags.length) {
    commands.push({
      name: 'push tag',
      run: user => {
        const tag = gen.words.next().value

        user.tags.push(tag)
        model.tags.push(tag)
      },
    })
    commands.push({
      name: 'set tag index',
      run: user => {
        const index = gen.int(model.tags.length)
        const tag = gen.words.next().value

        user.tags[index] = tag
        model.tags[index] = tag
      },
    })
    commands.push({
      name: 'splice tag',
      run: user => {
        const index = gen.int(model.tags.length)
        const tag = gen.words.next().value

        user.tags.splice(index, 1, tag)
        model.tags.splice(index, 1, tag)
      },
    })
    commands.push({
      name: 'truncate tags',
      run: user => {
        const length = gen.int(model.tags.length + 1)

        user.tags.length = length
        model.tags.length = length
      },
    })
  }

  return commands
}

test('Reactive', async t => {
  await t.test('#model', async t => {
    await t.test('local sequences match the plain-object model', async t => {
      for (let seed = 1; seed <= 20; seed++) {
        await t.test(`seed ${seed}`, async t => {
          const { User } = createContext()
          const gen = new Generator(seed)
          const model = initialState()
          const id = `local-${seed}`
          const user = new User(id, snapshot(model))

          t.assert.models(user, expected(id, model), {
            command: 'initial',
            seed,
            step: 'initial',
          })

          for (let step = 0; step < 40; step++) {
            const command = gen.pick(commandsFor(model, gen))

            command.run(user)

            t.assert.models(user, expected(id, model), {
              command: command.name,
              seed,
              step,
            })
            t.assert.strictEqual(new User(id, { ignored: true }), user)
          }
        })
      }
    })

    await t.test('replicated sequences converge to the same model', async t => {
      for (let seed = 1; seed <= 20; seed++) {
        await t.test(`seed ${seed}`, async t => {
          const { a, b } = createLinkedContexts()
          const gen = new Generator(seed)
          const model = initialState()
          const id = `linked-${seed}`
          const left = new a.User(id, snapshot(model))
          const right = await b.User.sync(id)

          t.assert.models(left, expected(id, model), {
            command: 'initial',
            seed,
            side: 'left',
            step: 'initial',
          })
          t.assert.models(right, expected(id, model), {
            command: 'initial',
            seed,
            side: 'right',
            step: 'initial',
          })

          for (let step = 0; step < 40; step++) {
            const actor = gen.bool() ? left : right
            const Ctor = actor === left ? a.User : b.User
            const side = actor === left ? 'left' : 'right'
            const command = gen.pick(commandsFor(model, gen))

            command.run(actor)

            t.assert.models(actor, expected(id, model), {
              command: command.name,
              seed,
              side,
              step,
            })
            t.assert.strictEqual(new Ctor(id, { ignored: true }), actor)

            await Bus.flush()

            t.assert.models(left, expected(id, model), {
              actor: side,
              command: command.name,
              seed,
              side: 'left',
              step,
            })
            t.assert.models(right, expected(id, model), {
              actor: side,
              command: command.name,
              seed,
              side: 'right',
              step,
            })
            t.assert.strictEqual(new a.User(id, { ignored: true }), left)
            t.assert.strictEqual(new b.User(id, { ignored: true }), right)
          }
        })
      }
    })
  })
})

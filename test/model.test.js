import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import {
  createContext,
  createLinkedContexts,
} from './utils/context/index.js'
import { Generator } from './utils/prop/index.js'

const snapshot = value => JSON.parse(JSON.stringify(value))

const initialState = () => ({
  address: { city: 'London', zip: 'SW1' },
  age: 1,
  name: 'A',
  tags: ['a', 'b'],
  temp: true,
})

const expected = (id, model) => ({ id, ...snapshot(model) })

const assertMatchesModel = (user, id, model) => {
  assert.deepEqual(snapshot(user), expected(id, model))
}

const assertReusesIdentity = (Ctor, id, user) => {
  assert.equal(new Ctor(id, { ignored: true }), user)
}

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

          assertMatchesModel(user, id, model)

          for (let step = 0; step < 40; step++) {
            const command = gen.pick(commandsFor(model, gen))

            command.run(user)

            assertMatchesModel(user, id, model)
            assertReusesIdentity(User, id, user)
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

          assertMatchesModel(left, id, model)
          assertMatchesModel(right, id, model)

          for (let step = 0; step < 40; step++) {
            const actor = gen.bool() ? left : right
            const Ctor = actor === left ? a.User : b.User
            const command = gen.pick(commandsFor(model, gen))

            command.run(actor)

            assertMatchesModel(actor, id, model)
            assertReusesIdentity(Ctor, id, actor)

            await Bus.flush()

            assertMatchesModel(left, id, model)
            assertMatchesModel(right, id, model)
            assertReusesIdentity(a.User, id, left)
            assertReusesIdentity(b.User, id, right)
          }
        })
      }
    })
  })
})

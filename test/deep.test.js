import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import {
  createContext,
  createLinkedContexts,
} from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#deep item edits', async t => {
    await t.test('delta path', async t => {
      t.beforeEach(async t => {
        t.ctx = createLinkedContexts()
      })

      await t.test('uses stable item identity, not index', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('path', {
          items: [{ name: 'A' }, { name: 'B' }],
        })

        user.items[0].name = 'X'
        await Bus.flush()

        const delta = bus.a.sent
          .findLast(message =>
            message.event === 'reactive:delta' &&
            message.payload.id === 'path')
          .payload

        t.assert.equal(delta.path.length, 3)
        t.assert.equal(delta.path[0], 'items')
        t.assert.equal(delta.path[2], 'name')
        t.assert.notEqual(delta.path[1], '0')
        t.assert.equal(delta.value, 'X')
      })

      await t.test('survives index shift from splice', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('shift', {
          items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        })

        user.items[2].name = 'C1'
        await Bus.flush()

        const first = bus.a.sent
          .findLast(message =>
            message.event === 'reactive:delta' &&
            message.payload.id === 'shift' &&
            message.payload.path.length === 3)

        t.assert.ok(first)

        const itemSegment = first.payload.path[1]

        user.items.splice(0, 1)
        await Bus.flush()

        user.items[1].name = 'C2'
        await Bus.flush()

        const second = bus.a.sent
          .findLast(message =>
            message.event === 'reactive:delta' &&
            message.payload.id === 'shift' &&
            message.payload.path.length === 3 &&
            message.payload.value === 'C2')

        t.assert.ok(second)
        t.assert.equal(second.payload.path[1], itemSegment)
      })

      await t.test('push emits a whole-list set, not an op', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('lstpush', {
          items: [{ name: 'A' }],
        })

        user.items.push({ name: 'B' })
        await Bus.flush()

        const delta = bus.a.sent
          .findLast(message =>
            message.event === 'reactive:delta' &&
            message.payload.id === 'lstpush')
          .payload

        t.assert.equal(delta.path[0], 'items')
        t.assert.equal(delta.op, undefined)
        t.assert.ok(Array.isArray(delta.value))
      })
    })

    await t.test('convergence', async t => {
      t.beforeEach(async t => {
        t.ctx = createLinkedContexts()
      })

      await t.test('concurrent edits to different items both survive', async t => {
        const { a, b } = t.ctx
        const left = new a.User('disjoint', {
          items: [{ name: 'A' }, { name: 'B' }],
        })
        const right = await b.User.sync('disjoint')

        left.items[0].name = 'X'
        right.items[1].name = 'Y'
        await Bus.flush()

        t.assert.equal(left.items[0].name, 'X')
        t.assert.equal(left.items[1].name, 'Y')
        t.assert.equal(right.items[0].name, 'X')
        t.assert.equal(right.items[1].name, 'Y')
      })
    })

    await t.test('transparency', async t => {
      t.beforeEach(async t => {
        t.ctx = createContext()
      })

      await t.test('toJSON excludes internal identity', async t => {
        const { User } = t.ctx
        const user = new User('tjson', {
          items: [{ name: 'A' }],
        })

        const json = JSON.parse(JSON.stringify(user))

        t.assert.equal(json.items[0].$iid, undefined)
        t.assert.equal(json.items[0].name, 'A')
      })

      await t.test('Object.keys excludes internal identity', async t => {
        const { User } = t.ctx
        const user = new User('tkeys', {
          items: [{ name: 'A', age: 1 }],
        })

        const keys = Object.keys(user.items[0]).sort()

        t.assert.deepEqual(keys, ['age', 'name'])
      })

      await t.test('spread excludes internal identity', async t => {
        const { User } = t.ctx
        const user = new User('tspread', {
          items: [{ name: 'A' }],
        })

        const copy = { ...user.items[0] }

        t.assert.deepEqual(copy, { name: 'A' })
      })
    })
  })
})

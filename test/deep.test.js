import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import {
  createContext,
  createLinkedContexts,
} from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#deep', async t => {
    await t.test('identified lists', async t => {
      t.beforeEach(t => {
        t.ctx = createLinkedContexts()
      })

      await t.test('uses stable item ids in delta paths', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('path', {
          items: [{ name: 'A' }, { name: 'B' }],
        })

        user.items[0].name = 'X'
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'path')

        t.assert.ok(deltaMessage)
        t.assert.strictEqual(deltaMessage.payload.path.length, 3)
        t.assert.strictEqual(deltaMessage.payload.path[0], 'items')
        t.assert.notStrictEqual(deltaMessage.payload.path[1], '0')
        t.assert.strictEqual(deltaMessage.payload.path[2], 'name')
        t.assert.strictEqual(deltaMessage.payload.value, 'X')
      })

      await t.test('keeps the same item id through repeated shifts', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('shifts', {
          items: Array.from({ length: 12 }, (_, index) => ({
            name: `Item ${index}`,
          })),
        })

        user.items[10].name = 'Kept 1'
        await Bus.flush()

        const first = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'shifts' &&
          message.payload.value === 'Kept 1')

        t.assert.ok(first)

        user.items.unshift({ name: 'Start' })
        user.items.splice(4, 1)
        user.items.shift()
        await Bus.flush()

        user.items.find(item => item.name === 'Kept 1').name = 'Kept 2'
        await Bus.flush()

        const second = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'shifts' &&
          message.payload.value === 'Kept 2')

        t.assert.ok(second)
        t.assert.strictEqual(second.payload.path[1], first.payload.path[1])
      })

      await t.test('preserves surviving item ids across whole-list sets', async t => {
        const { a, b, bus } = t.ctx
        const user = new a.User('whole-list', {
          items: [{ name: 'A' }, { name: 'B' }],
        })

        await b.User.sync('whole-list')

        const snapshotMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:snapshot:response' &&
          message.payload.id === 'whole-list')

        t.assert.ok(snapshotMessage)

        const before = Object.fromEntries(
          snapshotMessage.payload.data.items.map(item => [item.name, item.$iid])
        )

        user.items.splice(1, 0, { name: 'X' })
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'whole-list')

        t.assert.ok(deltaMessage)
        t.assert.strictEqual(deltaMessage.payload.op, undefined)
        t.assert.deepStrictEqual(
          deltaMessage.payload.value.map(item => item.name),
          ['A', 'X', 'B']
        )
        t.assert.strictEqual(deltaMessage.payload.value[0].$iid, before.A)
        t.assert.strictEqual(deltaMessage.payload.value[2].$iid, before.B)
        t.assert.ok(deltaMessage.payload.value[1].$iid)
        t.assert.notStrictEqual(deltaMessage.payload.value[1].$iid, before.A)
        t.assert.notStrictEqual(deltaMessage.payload.value[1].$iid, before.B)
      })

      await t.test('keeps writes on the item boundary for nested arrays', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('boundary', {
          items: [{ tags: ['a', 'b'] }],
        })

        user.items[0].tags[1] = 'x'
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'boundary')

        t.assert.ok(deltaMessage)
        t.assert.strictEqual(deltaMessage.payload.path.length, 3)
        t.assert.strictEqual(deltaMessage.payload.path[0], 'items')
        t.assert.strictEqual(deltaMessage.payload.path[2], 'tags')
        t.assert.strictEqual(deltaMessage.payload.op, undefined)
        t.assert.deepStrictEqual(deltaMessage.payload.value, ['a', 'x'])
      })

      await t.test('emits a granular delete for an item field', async t => {
        const { a, b, bus } = t.ctx
        const user = new a.User('item-del', {
          items: [{ name: 'A', tag: 'keep' }, { name: 'B' }],
        })
        const remote = await b.User.sync('item-del')

        delete user.items[0].tag
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'item-del')

        t.assert.ok(deltaMessage)
        t.assert.strictEqual(deltaMessage.payload.deleted, true)
        t.assert.strictEqual(deltaMessage.payload.path[0], 'items')
        t.assert.strictEqual(deltaMessage.payload.path.at(-1), 'tag')
        t.assert.strictEqual('tag' in remote.items[0], false)
        t.assert.strictEqual(remote.items[0].name, 'A')
      })
    })

    await t.test('transparency', async t => {
      t.beforeEach(t => {
        t.ctx = createContext()
      })

      await t.test('keeps item identity internal in user-visible shape', t => {
        const { User } = t.ctx
        const user = new User('internal', {
          items: [{ age: 1, name: 'A' }],
        })

        t.assert.strictEqual(
          JSON.parse(JSON.stringify(user)).items[0].$iid,
          undefined
        )
        t.assert.deepStrictEqual(
          Object.keys(user.items[0]).sort(),
          ['age', 'name']
        )
        t.assert.deepStrictEqual({ ...user.items[0] }, { age: 1, name: 'A' })
      })

      await t.test('returns plain arrays for identified lists on slice', t => {
        const { User } = t.ctx
        const user = new User('species', {
          items: [{ name: 'A' }, { name: 'B' }],
        })
        const copy = user.items.slice(0, 1)

        t.assert.ok(Array.isArray(copy))
        t.assert.strictEqual(copy.constructor, Array)
        t.assert.strictEqual(copy.length, 1)
        t.assert.deepStrictEqual({ ...copy[0] }, { name: 'A' })
      })

      await t.test('returns plain arrays on map across identified lists', t => {
        const { User } = t.ctx
        const user = new User('map', {
          items: [{ name: 'A' }, { name: 'B' }],
        })
        const names = user.items.map(item => item.name)

        t.assert.ok(Array.isArray(names))
        t.assert.strictEqual(names.constructor, Array)
        t.assert.deepStrictEqual(names, ['A', 'B'])
      })
    })
  })
})

import { test } from 'node:test'

import { createContext } from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#mutation', async t => {
    t.beforeEach(t => {
      t.ctx = createContext()
    })

    await t.test('top-level fields', async t => {
      await t.test('reads new values immediately after a write', t => {
        const { User } = t.ctx
        const user = new User('prim', { name: 'A' })

        user.name = 'B'
        user.nickname = 'Bee'

        t.assert.strictEqual(user.name, 'B')
        t.assert.strictEqual(user.nickname, 'Bee')
      })

      await t.test('removes fields after a delete', t => {
        const { User } = t.ctx
        const user = new User('del', { name: 'A', temp: true })

        delete user.temp
        delete user.name

        t.assert.strictEqual('temp' in user, false)
        t.assert.strictEqual('name' in user, false)
        t.assert.deepStrictEqual(Object.keys(user), [])
      })

      await t.test('returns true when deleting a missing field', t => {
        const { User } = t.ctx
        const user = new User('missing-del', { name: 'A' })

        t.assert.strictEqual(delete user.absent, true)
        t.assert.strictEqual('name' in user, true)
      })
    })

    await t.test('nested objects', async t => {
      await t.test('keeps sibling fields intact when a leaf changes', t => {
        const { User } = t.ctx
        const user = new User('nested', {
          address: { city: 'London', zip: 'SW1' },
        })

        user.address.city = 'Berlin'

        t.assert.strictEqual(user.address.city, 'Berlin')
        t.assert.strictEqual(user.address.zip, 'SW1')
      })

      await t.test('rejects writes through a stale alias', t => {
        const { User } = t.ctx
        const user = new User('stale', {
          address: { city: 'London' },
        })
        const address = user.address

        user.address = { city: 'Berlin' }

        t.assert.throws(
          () => {
            address.city = 'Paris'
          },
          /Stale reactive reference/,
        )
        t.assert.strictEqual(user.address.city, 'Berlin')
      })
    })

    await t.test('arrays', async t => {
      await t.test('stay live after chained structural updates', t => {
        const { User } = t.ctx
        const user = new User('array', {
          tags: ['a', 'b', 'c', 'd'],
        })

        user.tags.push('e')
        user.tags.splice(1, 1, 'z')
        user.tags.copyWithin(0, 2, 4)
        user.tags.fill('x', 3, 5)

        t.assert.deepStrictEqual([...user.tags], ['c', 'd', 'c', 'x', 'x'])
      })

      await t.test('keep the proxied array for self-returning methods', t => {
        const { User } = t.ctx
        const user = new User('sort', { tags: ['b', 'a'] })
        const result = user.tags.sort()

        t.assert.strictEqual(result, user.tags)
        t.assert.deepStrictEqual([...user.tags], ['a', 'b'])
      })

      await t.test('return plain values for non-self-returning mutators', t => {
        const { User } = t.ctx
        const user = new User('splice-return', { tags: ['a', 'b', 'c'] })
        const removed = user.tags.splice(0, 2)

        t.assert.ok(Array.isArray(removed))
        t.assert.notStrictEqual(removed, user.tags)
        t.assert.deepStrictEqual(removed, ['a', 'b'])
        t.assert.deepStrictEqual([...user.tags], ['c'])
      })

      await t.test('pop returns the removed value', t => {
        const { User } = t.ctx
        const user = new User('pop', { tags: ['a', 'b'] })

        t.assert.strictEqual(user.tags.pop(), 'b')
        t.assert.deepStrictEqual([...user.tags], ['a'])
      })

      await t.test('supports multi-digit indexed writes', t => {
        const { User } = t.ctx
        const user = new User('index-10', {
          tags: Array.from({ length: 12 }, (_, index) => String(index)),
        })

        user.tags[10] = 'ten'

        t.assert.strictEqual(user.tags[10], 'ten')
        t.assert.strictEqual(user.tags.length, 12)
      })

      await t.test('truncates the live array on a length write', t => {
        const { User } = t.ctx
        const user = new User('trunc', { tags: ['a', 'b', 'c'] })

        user.tags.length = 2

        t.assert.deepStrictEqual([...user.tags], ['a', 'b'])
      })

      await t.test('keeps sparse holes observable after a delete', t => {
        const { User } = t.ctx
        const user = new User('holes', { tags: ['a', 'b', 'c'] })

        delete user.tags[1]

        t.assert.strictEqual(1 in user.tags, false)
        t.assert.strictEqual(user.tags.length, 3)
        t.assert.deepStrictEqual(Object.keys(user.tags), ['0', '2'])
      })

      await t.test('keeps empty arrays as plain Array', t => {
        const { User } = t.ctx
        const user = new User('empty', { tags: [] })

        t.assert.ok(Array.isArray(user.tags))
        t.assert.strictEqual(user.tags.constructor, Array)
      })

      await t.test('keeps mixed arrays as plain Array', t => {
        const { User } = t.ctx
        const user = new User('mixed', {
          mixed: [{ name: 'x' }, 'string', 1],
        })

        t.assert.ok(Array.isArray(user.mixed))
        t.assert.strictEqual(user.mixed.constructor, Array)
        t.assert.strictEqual(user.mixed[1], 'string')
        t.assert.strictEqual(user.mixed[2], 1)
      })
    })
  })

  await t.test('#shape', async t => {
    t.beforeEach(t => {
      const { User } = createContext()

      t.user = new User('shape', { name: 'A', age: 1 })
    })

    await t.test('Object.keys reflects current properties', t => {
      t.assert.deepStrictEqual(Object.keys(t.user).sort(), ['age', 'name'])
    })

    await t.test('spread copies current state', t => {
      t.assert.deepStrictEqual({ ...t.user }, { age: 1, name: 'A' })
    })

    await t.test('JSON.stringify includes id', t => {
      t.assert.deepStrictEqual(JSON.parse(JSON.stringify(t.user)), {
        age: 1,
        id: 'shape',
        name: 'A',
      })
    })
  })
})

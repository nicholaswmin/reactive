import { test } from 'node:test'

import { createContext } from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#mutation', async t => {
    t.beforeEach(async t => {
      t.ctx = createContext()
    })

    await t.test('primitive write', async t => {
      await t.test('readable immediately', async t => {
        const { User } = t.ctx
        const user = new User('prim', { name: 'A' })

        user.name = 'B'

        t.assert.equal(user.name, 'B')
      })
    })

    await t.test('nested write', async t => {
      await t.test('tracks the change', async t => {
        const { User } = t.ctx
        const user = new User('nested', {
          address: { city: 'London', zip: 'SW1' },
        })

        user.address.city = 'Berlin'

        t.assert.equal(user.address.city, 'Berlin')
      })

      await t.test('preserves sibling properties', async t => {
        const { User } = t.ctx
        const user = new User('sibling', {
          address: { city: 'London', zip: 'SW1' },
        })

        user.address.city = 'Berlin'

        t.assert.equal(user.address.zip, 'SW1')
      })

      await t.test('rejects stale nested aliases after replacement', async t => {
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
        t.assert.equal(user.address.city, 'Berlin')
      })
    })

    await t.test('delete', async t => {
      await t.test('removes the property', async t => {
        const { User } = t.ctx
        const user = new User('del', { name: 'A', temp: true })

        delete user.temp

        t.assert.equal('temp' in user, false)
      })
    })

    await t.test('array', async t => {
      await t.test('push appends', async t => {
        const { User } = t.ctx
        const user = new User('push', { tags: ['a', 'b'] })

        user.tags.push('c')

        t.assert.deepEqual([...user.tags], ['a', 'b', 'c'])
      })

      await t.test('splice replaces', async t => {
        const { User } = t.ctx
        const user = new User('splice', { tags: ['a', 'b', 'c'] })

        user.tags.splice(1, 1, 'z')

        t.assert.deepEqual([...user.tags], ['a', 'z', 'c'])
      })

      await t.test('self-returning mutators keep the proxy', async t => {
        const { User } = t.ctx
        const user = new User('sort', { tags: ['b', 'a'] })
        const result = user.tags.sort()

        t.assert.equal(result, user.tags)
        t.assert.deepEqual([...user.tags], ['a', 'b'])
      })

      await t.test('index write updates', async t => {
        const { User } = t.ctx
        const user = new User('index', { tags: ['a', 'b'] })

        user.tags[0] = 'x'

        t.assert.deepEqual([...user.tags], ['x', 'b'])
      })

      await t.test('length truncation shrinks', async t => {
        const { User } = t.ctx
        const user = new User('trunc', { tags: ['a', 'b', 'c'] })

        user.tags.length = 2

        t.assert.deepEqual([...user.tags], ['a', 'b'])
      })
    })
  })

  await t.test('#shape', async t => {
    t.beforeEach(async t => {
      const { User } = createContext()

      t.user = new User('shape', { name: 'A', age: 1 })
    })

    await t.test('Object.keys reflects current properties', async t => {
      t.assert.deepEqual(Object.keys(t.user).sort(), ['age', 'name'])
    })

    await t.test('spread copies current state', async t => {
      t.assert.deepEqual({ ...t.user }, { age: 1, name: 'A' })
    })

    await t.test('JSON.stringify includes id', async t => {
      t.assert.deepEqual(JSON.parse(JSON.stringify(t.user)), {
        id: 'shape',
        name: 'A',
        age: 1,
      })
    })
  })
})

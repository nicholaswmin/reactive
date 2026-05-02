import { test } from 'node:test'

import { Reactive } from '../src/index.js'
import { createContext } from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#identity', async t => {
    t.beforeEach(t => {
      t.ctx = createContext()
    })

    await t.test('id assignment', async t => {
      await t.test('preserves an explicit id', t => {
        const { User } = t.ctx
        const user = new User('abc-123', { name: 'John' })

        t.assert.strictEqual(user.id, 'abc-123')
      })

      await t.test('generates a different id when omitted', t => {
        const { User } = t.ctx
        const first = new User({ name: 'A' })
        const second = new User({ name: 'B' })

        t.assert.ok(typeof first.id === 'string')
        t.assert.ok(typeof second.id === 'string')
        t.assert.notStrictEqual(first.id, second.id)
      })

      await t.test('accepts an id without data', t => {
        const { User } = t.ctx
        const user = new User('only-id')

        t.assert.strictEqual(user.id, 'only-id')
        t.assert.deepStrictEqual({ ...user }, {})
      })

      await t.test('accepts no arguments and generates an id', t => {
        const { User } = t.ctx
        const user = new User()

        t.assert.ok(typeof user.id === 'string')
        t.assert.deepStrictEqual({ ...user }, {})
      })
    })

    await t.test('instance reuse', async t => {
      await t.test('returns the same instance for the same (type, id)', t => {
        const { User } = t.ctx
        const first = new User('same', { name: 'A' })
        const second = new User('same', { name: 'B' })

        t.assert.strictEqual(first, second)
        t.assert.strictEqual(second.name, 'A')
      })

      await t.test('keeps shared ids separate across classes', t => {
        const { Post, User } = t.ctx
        const user = new User('shared', { name: 'John' })
        const post = new Post('shared', { title: 'Hello' })

        t.assert.notStrictEqual(user, post)
        t.assert.strictEqual(user.id, 'shared')
        t.assert.strictEqual(post.id, 'shared')
      })
    })

    await t.test('instanceof', async t => {
      await t.test('stays true for the subclass through the proxy', t => {
        const { User } = t.ctx
        const user = new User('proxy', { name: 'John' })

        t.assert.ok(user instanceof User)
      })

      await t.test('stays true for the base class through the proxy', t => {
        const { User } = t.ctx
        const user = new User('proxy-base', { name: 'John' })

        t.assert.ok(user instanceof Reactive)
      })
    })

    await t.test('explicit types', async t => {
      await t.test('rejects an empty type string', t => {
        class EmptyType extends Reactive {
          static type = ''
        }

        t.assert.throws(() => new EmptyType('bad', {}), /non-empty string/)
      })

      await t.test('rejects a non-string type', t => {
        class NumberType extends Reactive {
          static type = 1
        }

        t.assert.throws(() => new NumberType('bad', {}), /non-empty string/)
      })
    })

    await t.test('id enumeration', async t => {
      await t.test('is hidden from Object.keys', t => {
        const { User } = t.ctx
        const user = new User('hidden', { name: 'A' })

        t.assert.strictEqual(Object.keys(user).includes('id'), false)
      })

      await t.test('surfaces only in toJSON output', t => {
        const { User } = t.ctx
        const user = new User('surface', { name: 'A' })

        t.assert.strictEqual(
          JSON.parse(JSON.stringify(user)).id,
          'surface'
        )
      })
    })
  })
})

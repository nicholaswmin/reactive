import { test } from 'node:test'

import { createContext } from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#identity', async t => {
    t.beforeEach(t => {
      t.ctx = createContext()
    })

    await t.test('id assignment', async t => {
      await t.test('preserves provided id', async t => {
        const { User } = t.ctx
        const user = new User('abc-123', { name: 'John' })

        t.assert.strictEqual(user.id, 'abc-123')
      })

      await t.test('generates unique id when omitted', async t => {
        const { User } = t.ctx
        const first = new User({ name: 'A' })
        const second = new User({ name: 'B' })

        t.assert.notStrictEqual(first.id, second.id)
      })
    })

    await t.test('instance reuse', async t => {
      await t.test('returns same instance for same class and id', async t => {
        const { User } = t.ctx
        const first = new User('same', { name: 'A' })
        const second = new User('same', { name: 'B' })

        t.assert.strictEqual(first, second)
      })

      await t.test('returns separate instances for different classes', async t => {
        const { User, Post } = t.ctx
        const user = new User('shared', { name: 'John' })
        const post = new Post('shared', { title: 'Hello' })

        t.assert.notStrictEqual(user, post)
      })
    })

    await t.test('instanceof', async t => {
      await t.test('matches subclass', async t => {
        const { User } = t.ctx
        const user = new User('proxy', { name: 'John' })

        t.assert.ok(user instanceof User)
      })

      await t.test('matches base class', async t => {
        const { Reactive, User } = t.ctx
        const user = new User('proxy-base', { name: 'John' })

        t.assert.ok(user instanceof Reactive)
      })
    })
  })
})

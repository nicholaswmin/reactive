import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import { createLinkedContexts } from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#nested refs', async t => {
    t.beforeEach(async t => {
      t.ctx = createLinkedContexts()
    })

    await t.test('serialization', async t => {
      await t.test('produces $ref and id', async t => {
        const { a } = t.ctx
        const child = new a.User('child', { name: 'Freida' })
        const parent = new a.User('parent', { children: [child] })

        t.assert.deepEqual(JSON.parse(JSON.stringify(parent)), {
          id: 'parent',
          children: [{ $ref: 'User', id: 'child' }],
        })
      })

      await t.test('handles circular refs', async t => {
        const { a } = t.ctx
        const left = new a.User('left', { peer: null })
        const right = new a.User('right', { peer: left })

        left.peer = right

        t.assert.doesNotThrow(() => JSON.stringify(left))
      })
    })

    await t.test('hydration', async t => {
      await t.test('creates live instances from refs', async t => {
        const { a, b } = t.ctx
        const child = new a.User('child-live', { name: 'Freida' })

        new a.User('parent-live', { children: [child] })

        const parent = await b.User.sync('parent-live')

        t.assert.equal(parent.children[0] instanceof b.User, true)
      })

      await t.test('restores current state', async t => {
        const { a, b } = t.ctx
        const child = new a.User('child-state', { name: 'Freida' })

        new a.User('parent-state', { children: [child] })

        const parent = await b.User.sync('parent-state')

        t.assert.equal(parent.children[0].name, 'Freida')
      })
    })

    await t.test('push ref via op', async t => {
      await t.test('hydrates on remote', async t => {
        const { a, b } = t.ctx
        const parent = new a.User('op-parent', { children: [] })
        const child = new a.User('op-child', { name: 'Freida' })

        await b.User.sync('op-parent')
        await b.User.sync('op-child')

        parent.children.push(child)
        await Bus.flush()

        const remote = await b.User.sync('op-parent')

        t.assert.equal(remote.children[0] instanceof b.User, true)
        t.assert.equal(remote.children[0].name, 'Freida')
      })
    })

    await t.test('ref removal', async t => {
      await t.test('child remains addressable', async t => {
        const { a, b } = t.ctx
        const child = new a.User('child-kept', { name: 'Freida' })
        const parent = new a.User('parent-kept', {
          children: [child],
        })

        await b.User.sync('parent-kept')

        parent.children.splice(0, 1)
        await Bus.flush()

        const remote = await b.User.sync('child-kept')

        t.assert.equal(remote.name, 'Freida')
      })
    })
  })
})

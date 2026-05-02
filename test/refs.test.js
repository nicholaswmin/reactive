import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import { createLinkedContexts } from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#refs', async t => {
    t.beforeEach(t => {
      t.ctx = createLinkedContexts()
    })

    await t.test('serialization', async t => {
      await t.test('uses typed refs for nested reactives', t => {
        const { a } = t.ctx
        const child = new a.User('child', { name: 'Freida' })
        const parent = new a.User('parent', { children: [child] })

        t.assert.deepStrictEqual(JSON.parse(JSON.stringify(parent)), {
          children: [{ $ref: 'User', id: 'child' }],
          id: 'parent',
        })
      })

      await t.test('stays serializable across cycles', t => {
        const { a } = t.ctx
        const left = new a.User('left', { peer: null })
        const right = new a.User('right', { peer: left })

        left.peer = right

        t.assert.doesNotThrow(() => JSON.stringify(left))
      })

      await t.test('writes refs through the child id on the wire', async t => {
        const { a, bus } = t.ctx
        const child = new a.User('child-path', { name: 'Freida' })

        new a.User('parent-path', { child })

        child.name = 'Freida Doe'
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.path.at(-1) === 'name')

        t.assert.ok(deltaMessage)
        t.assert.strictEqual(deltaMessage.payload.id, 'child-path')
      })
    })

    await t.test('hydration', async t => {
      await t.test('hydrates reachable refs as live authoritative instances', async t => {
        const { a, b, bus } = t.ctx
        const child = new a.User('child-live', {
          name: 'Freida',
          tags: ['a'],
        })

        new a.User('parent-live', { children: [child] })

        const parent = await b.User.sync('parent-live')
        const sameChild = await b.User.sync('child-live')

        t.assert.ok(parent.children[0] instanceof b.User)
        t.assert.strictEqual(parent.children[0], sameChild)
        t.assert.strictEqual(parent.children[0].name, 'Freida')

        const responseMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:snapshot:response' &&
          message.payload.id === 'parent-live')

        t.assert.ok(responseMessage)
        t.assert.deepStrictEqual(
          responseMessage.payload.refs.map(ref => ref.id),
          ['child-live']
        )

        parent.children[0].tags.push('x')
        await Bus.flush()

        t.assert.deepStrictEqual([...child.tags], ['a', 'x'])
      })

      await t.test('restores the live graph across cycles', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('cycle-left', { peer: null })
        const right = new a.User('cycle-right', { peer: left })

        left.peer = right

        const remote = await b.User.sync('cycle-left')
        const responseMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:snapshot:response' &&
          message.payload.id === 'cycle-left')

        t.assert.ok(responseMessage)
        t.assert.deepStrictEqual(
          responseMessage.payload.refs.map(ref => ref.id),
          ['cycle-right']
        )
        t.assert.ok(remote.peer instanceof b.User)
        t.assert.strictEqual(remote.peer.peer, remote)
      })

      await t.test('hydrates op-delivered refs when the child is known', async t => {
        const { a, b } = t.ctx
        const parent = new a.User('op-parent', { children: [] })
        const child = new a.User('op-child', { name: 'Freida' })
        const remote = await b.User.sync('op-parent')

        await b.User.sync('op-child')

        parent.children.push(child)
        await Bus.flush()

        t.assert.ok(remote.children[0] instanceof b.User)
        t.assert.strictEqual(remote.children[0].name, 'Freida')
      })

      await t.test('keeps unregistered refs as plain objects', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('orphan-parent', { name: 'P' })

        bus.a.receive('reactive:delta', {
          class: 'User',
          id: 'orphan-parent',
          path: ['extern'],
          value: { $ref: 'Unregistered', id: 'x' },
          version: { tick: 999, context: 'remote' },
        })
        await Bus.flush()

        t.assert.deepStrictEqual(user.extern, {
          $ref: 'Unregistered',
          id: 'x',
        })
      })
    })

    await t.test('addressability', async t => {
      await t.test('keeps the child syncable after parent ref removal', async t => {
        const { a, b } = t.ctx
        const child = new a.User('child-kept', { name: 'Freida' })
        const parent = new a.User('parent-kept', {
          children: [child],
        })

        await b.User.sync('parent-kept')

        parent.children.splice(0, 1)
        await Bus.flush()

        const remote = await b.User.sync('child-kept')

        t.assert.strictEqual(remote.name, 'Freida')
      })
    })

    await t.test('repair refusal', async t => {
      await t.test('rejects parent sync when a reachable ref is non-authoritative', async t => {
        const { a, b, bus } = t.ctx
        const child = new a.User('child-pending', { tags: ['a'] })

        new a.User('parent-pending', { child })

        bus.a.drop()
        bus.a.receive('reactive:delta', {
          args: ['x'],
          baseVersion: { context: 'remote', tick: 999 },
          class: 'User',
          id: 'child-pending',
          op: 'push',
          path: ['tags'],
          version: { context: 'remote', tick: 1000 },
        })
        await Bus.flush()

        bus.a.pass()
        b.User.syncTimeoutMs = 10

        try {
          await t.assert.rejects(
            b.User.sync('parent-pending'),
            /Unknown User:parent-pending/
          )
        } finally {
          delete b.User.syncTimeoutMs
        }
      })
    })
  })
})

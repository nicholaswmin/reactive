import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import { createLinkedContexts } from './utils/context/index.js'

const snapshot = value => JSON.parse(JSON.stringify(value))

test('Reactive', async t => {
  await t.test('#regression', async t => {
    await t.test('mixed identified list does not leak $iid', async t => {
      const { a, b } = createLinkedContexts()
      const left = new a.User('p2', { items: [{ name: 'A' }] })
      await b.User.sync('p2')

      left.items.push(42)

      await Bus.flush()

      const right = await b.User.sync('p2')
      const wire = snapshot(right)

      for (const item of wire.items)
        if (item && typeof item === 'object')
          t.assert.ok(!('$iid' in item),
            `unexpected $iid leak: ${JSON.stringify(item)}`)
    })

    await t.test('cloning a list item assigns a new identity', async t => {
      const { a, b } = createLinkedContexts()
      const left = new a.User('p3', { items: [{ name: 'A' }] })
      const right = await b.User.sync('p3')

      left.items.push(left.items[0])

      await Bus.flush()

      t.assert.strictEqual(left.items.length, 2)
      t.assert.strictEqual(right.items.length, 2)

      left.items[1].name = 'B'

      await Bus.flush()

      t.assert.strictEqual(left.items[0].name, 'A')
      t.assert.strictEqual(left.items[1].name, 'B')
      t.assert.strictEqual(right.items[0].name, 'A')
      t.assert.strictEqual(right.items[1].name, 'B')
    })

    await t.test('primitive array starting empty stays plain', async t => {
      const { a, b } = createLinkedContexts()
      const left = new a.User('p4', { tags: [] })
      const right = await b.User.sync('p4')

      left.tags.push('alpha')

      await Bus.flush()

      t.assert.deepStrictEqual(snapshot(left).tags, ['alpha'])
      t.assert.deepStrictEqual(snapshot(right).tags, ['alpha'])
    })
  })
})

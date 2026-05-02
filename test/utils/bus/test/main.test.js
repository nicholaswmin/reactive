import { test } from 'node:test'

import { Bus } from '../index.js'

test('Bus', async t => {
  await t.test('delivery', async t => {
    t.beforeEach(t => {
      const { a, b } = Bus.createPair()

      t.a = a
      t.b = b
    })

    await t.test('forwards payload to remote peer', async t => {
      const received = new Promise(resolve =>
        t.b.on('delta', resolve))

      t.a.send('delta', { id: 'abc', path: ['name'] })

      t.assert.deepStrictEqual(await received, {
        id: 'abc',
        path: ['name'],
      })
    })

    await t.test('works in both directions', async t => {
      const received = new Promise(resolve =>
        t.a.on('delta', resolve))

      t.b.send('delta', { from: 'b' })

      t.assert.deepStrictEqual(await received, { from: 'b' })
    })

    await t.test('preserves message order', async t => {
      const expected = [1, 2, 3]

      t.plan(expected.length)

      const done = new Promise(resolve => {
        t.b.on('delta', v => {
          t.assert.strictEqual(v, expected.shift())

          if (!expected.length)
            resolve()
        })
      })

      t.a.send('delta', 1)
      t.a.send('delta', 2)
      t.a.send('delta', 3)
      await done
    })

    await t.test('records sent messages', async t => {
      t.a.send('delta', { v: 1 })
      t.a.send('delta', { v: 2 })

      t.assert.deepStrictEqual(t.a.sent, [
        { event: 'delta', payload: { v: 1 } },
        { event: 'delta', payload: { v: 2 } },
      ])
    })
  })

  await t.test('drop', async t => {
    t.beforeEach(t => {
      const { a, b } = Bus.createPair()

      t.a = a
      t.b = b
    })

    await t.test('silences outbound messages', async t => {
      let received = false

      t.b.on('delta', () => (received = true))

      t.a.drop()
      t.a.send('delta', { v: 1 })
      await Bus.flush()

      t.assert.strictEqual(received, false)
    })

    await t.test('still records to sent', async t => {
      t.a.drop()
      t.a.send('delta', { v: 1 })

      t.assert.strictEqual(t.a.sent.length, 1)
    })

    await t.test('resumes after pass', async t => {
      const received = new Promise(resolve =>
        t.b.on('delta', resolve))

      t.a.drop()
      t.a.send('delta', { v: 'lost' })
      await Bus.flush()

      t.a.pass()
      t.a.send('delta', { v: 'ok' })

      t.assert.deepStrictEqual(await received, { v: 'ok' })
    })
  })

  await t.test('multiple handlers', async t => {
    await t.test('dispatches to all listeners', async t => {
      const { a, b } = Bus.createPair()
      let count = 0

      b.on('delta', () => count++)
      b.on('delta', () => count++)

      a.send('delta', {})
      await Bus.flush()

      t.assert.strictEqual(count, 2)
    })

    await t.test('cleanup removes individual listener', async t => {
      const { a, b } = Bus.createPair()
      let count = 0

      const cleanup = b.on('delta', () => count++)
      b.on('delta', () => count++)

      cleanup()
      a.send('delta', {})
      await Bus.flush()

      t.assert.strictEqual(count, 1)
    })
  })
})

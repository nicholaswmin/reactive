import { test } from 'node:test'

import { Bus } from './utils/bus/index.js'
import {
  createContext,
  createLinkedContexts,
} from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#sync', async t => {
    t.beforeEach(async t => {
      t.ctx = createLinkedContexts()
    })

    await t.test('local instance exists', async t => {
      await t.test('returns it', async t => {
        const { a } = t.ctx
        const local = new a.User('local', { name: 'John' })

        t.assert.equal(await a.User.sync('local'), local)
      })
    })

    await t.test('remote instance', async t => {
      await t.test('hydrates from snapshot', async t => {
        const { a, b } = t.ctx

        new a.User('sync', {
          name: 'John',
          address: { city: 'London' },
        })

        const remote = await b.User.sync('sync')

        t.assert.equal(remote.name, 'John')
      })

      await t.test('hydrates nested state', async t => {
        const { a, b } = t.ctx

        new a.User('nested', {
          address: { city: 'London' },
        })

        const remote = await b.User.sync('nested')

        t.assert.equal(remote.address.city, 'London')
      })
    })
  })

  await t.test('#replication', async t => {
    t.beforeEach(async t => {
      t.ctx = createLinkedContexts()
    })

    await t.test('outbound delta', async t => {
      await t.test('includes class, id, path, value, and version', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('delta', { name: 'A' })

        user.name = 'B'
        await Bus.flush()

        const delta = bus.a.sent.at(-1).payload

        t.assert.partialDeepStrictEqual(delta, {
          class: 'User',
          id: 'delta',
          path: ['name'],
          value: 'B',
        })
        t.assert.ok(Number.isInteger(delta.version?.tick))
      })
    })

    await t.test('inbound delta', async t => {
      await t.test('applies in place', async t => {
        const { a, b } = t.ctx
        const left = new a.User('apply', { name: 'A' })
        const right = await b.User.sync('apply')

        left.name = 'B'
        await Bus.flush()

        t.assert.equal(right.name, 'B')
      })

      await t.test('applies deletes', async t => {
        const { a, b } = t.ctx
        const left = new a.User('del', { name: 'John', temp: true })
        const right = await b.User.sync('del')

        delete left.temp
        await Bus.flush()

        t.assert.equal('temp' in right, false)
      })

      await t.test('does not echo back', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('echo', { name: 'A' })

        await b.User.sync('echo')

        bus.b.sent.length = 0
        left.name = 'B'
        await Bus.flush()

        t.assert.equal(bus.b.sent.length, 0)
      })

      await t.test('materializes unknown ids', async t => {
        const { a, b } = t.ctx
        const left = new a.User('late', { name: 'A' })

        left.name = 'B'
        await Bus.flush()

        const right = await b.User.sync('late')

        t.assert.equal(right.name, 'B')
      })
    })

    await t.test('child ref', async t => {
      await t.test('replicates independently of parent', async t => {
        const { a, b } = t.ctx
        const child = new a.User('child-mut', { name: 'Freida' })

        new a.User('parent-mut', { children: [child] })

        const parent = await b.User.sync('parent-mut')

        child.name = 'Freida Doe'
        await Bus.flush()

        t.assert.equal(parent.children[0].name, 'Freida Doe')
      })
    })

    await t.test('convergence', async t => {
      await t.test('source write reaches remote', async t => {
        const { a, b } = t.ctx
        const left = new a.User('fwd', { name: 'John', age: 30 })
        const right = await b.User.sync('fwd')

        left.name = 'Jane'
        await Bus.flush()

        t.assert.equal(right.name, 'Jane')
      })

      await t.test('remote write reaches source', async t => {
        const { a, b } = t.ctx
        const left = new a.User('rev', { name: 'John', age: 30 })
        const right = await b.User.sync('rev')

        right.age = 31
        await Bus.flush()

        t.assert.equal(left.age, 31)
      })
    })

    await t.test('conflict', async t => {
      await t.test('later write wins', async t => {
        const { a, b } = t.ctx
        const left = new a.User('conflict', { name: 'A' })
        const right = await b.User.sync('conflict')

        left.name = 'X'
        await Bus.flush()
        right.name = 'Y'
        await Bus.flush()

        t.assert.equal(left.name, 'Y')
      })
    })

    await t.test('sibling paths', async t => {
      await t.test('converge on source side', async t => {
        const { a, b } = t.ctx
        const left = new a.User('sib-src', {
          address: { city: 'A', zip: '1' },
        })
        const right = await b.User.sync('sib-src')

        left.address.city = 'London'
        right.address.zip = '99999'
        await Bus.flush()

        t.assert.deepEqual(
          { ...left.address },
          { city: 'London', zip: '99999' }
        )
      })

      await t.test('converge on remote side', async t => {
        const { a, b } = t.ctx
        const left = new a.User('sib-rem', {
          address: { city: 'A', zip: '1' },
        })
        const right = await b.User.sync('sib-rem')

        left.address.city = 'London'
        right.address.zip = '99999'
        await Bus.flush()

        t.assert.deepEqual(
          { ...right.address },
          { city: 'London', zip: '99999' }
        )
      })
    })

    await t.test('arrays', async t => {
      await t.test('replicates mutations', async t => {
        const { a, b } = t.ctx
        const left = new a.User('arr', { tags: ['a', 'b'] })
        const right = await b.User.sync('arr')

        left.tags.push('c')
        left.tags.splice(1, 1, 'z')
        await Bus.flush()

        t.assert.deepEqual([...right.tags], ['a', 'z', 'c'])
      })

      await t.test('concurrent push', async t => {
        await t.test('preserves both elements', async t => {
          const { a, b } = t.ctx
          const left = new a.User('cpush', { tags: ['a'] })
          const right = await b.User.sync('cpush')

          left.tags.push('x')
          right.tags.push('y')
          await Bus.flush()

          t.assert.ok([...left.tags].includes('x'))
          t.assert.ok([...left.tags].includes('y'))
          t.assert.ok([...right.tags].includes('x'))
          t.assert.ok([...right.tags].includes('y'))
        })
      })

      await t.test('outbound delta', async t => {
        await t.test('includes op and args', async t => {
          const { a, bus } = t.ctx
          const user = new a.User('aop', { tags: ['a'] })

          user.tags.push('b')
          await Bus.flush()

          const delta = bus.a.sent.at(-1).payload

          t.assert.partialDeepStrictEqual(delta, {
            path: ['tags'],
            op: 'push',
            args: ['b'],
          })
          t.assert.equal(delta.value, undefined)
        })
      })

      await t.test('splice', async t => {
        await t.test('replays on remote', async t => {
          const { a, b } = t.ctx
          const left = new a.User('spl', { tags: ['a', 'b', 'c'] })
          const right = await b.User.sync('spl')

          left.tags.splice(1, 1, 'z')
          await Bus.flush()

          t.assert.deepEqual([...right.tags], ['a', 'z', 'c'])
        })
      })
    })

    await t.test('class routing', async t => {
      await t.test('scopes snapshots to class', async t => {
        const { a, b } = t.ctx

        new a.User('shared', { name: 'John' })
        new a.Post('shared', { title: 'Hello' })

        const user = await b.User.sync('shared')

        t.assert.equal(user.name, 'John')
      })

      await t.test('scopes deltas to class', async t => {
        const { a, b } = t.ctx

        new a.User('shared', { name: 'John' })
        new a.Post('shared', { title: 'Hello' })

        const post = await b.Post.sync('shared')

        t.assert.equal(post.title, 'Hello')
      })
    })
  })

  await t.test('#use', async t => {
    await t.test('tears down previous subscriptions on rebind', async t => {
      const { User } = createContext()
      const unsubscribe = t.mock.fn()
      const first = { on: () => unsubscribe, send: () => {} }
      const second = {
        on: t.mock.fn(() => () => {}),
        send: () => {},
      }

      User.use(first)
      User.use(second)

      t.assert.equal(unsubscribe.mock.callCount(), 3)
    })
  })
})

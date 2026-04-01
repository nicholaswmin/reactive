import { test } from 'node:test'

import { Reactive } from '../src/index.js'
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

      await t.test('waits for a matching snapshot response', async t => {
        const a = createContext()
        const b = createContext()
        const { a: leftBus, b: rightBus } = Bus.createPair()

        b.User.use(rightBus)

        const pending = b.User.sync('authoritative')
        const request = rightBus.sent.at(-1).payload
        let settled = false

        pending.finally(() => {
          settled = true
        })

        rightBus.receive('reactive:delta', {
          class: 'User',
          id: 'authoritative',
          path: ['name'],
          value: 'B',
          version: { tick: 1, context: 'remote' },
        })
        await Bus.flush()

        t.assert.equal(settled, false)

        rightBus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'authoritative',
          requestId: request.requestId,
          data: { age: 1, name: 'A' },
          refs: [],
          versions: [],
        })

        const remote = await pending

        t.assert.equal(remote.name, 'B')
        t.assert.equal(remote.age, 1)
        t.assert.equal(leftBus.sent.length, 0)
      })

      await t.test('rejects explicit missing responses', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)

        const pending = User.sync('missing')
        const request = bus.sent.at(-1).payload

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'missing',
          missing: true,
          requestId: request.requestId,
        })

        await t.assert.rejects(pending, /Unknown User:missing/)
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
        await t.test('repairs to a single converged array', async t => {
          const { a, b } = t.ctx
          const left = new a.User('cpush', { tags: ['a'] })
          const right = await b.User.sync('cpush')

          left.tags.push('x')
          right.tags.push('y')
          await Bus.flush()
          await Bus.flush()

          t.assert.deepEqual([...left.tags], [...right.tags])
          t.assert.equal(left.tags.length, 2)
          t.assert.equal(left.tags[0], 'a')
        })
      })

      await t.test('outbound delta', async t => {
        await t.test('includes op and args', async t => {
          const { a, bus } = t.ctx
          const user = new a.User('aop', { tags: ['a'] })

          user.tags.push('b')
          await Bus.flush()

          const delta = bus.a.sent
            .findLast(message => message.event === 'reactive:delta')
            .payload

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

      await t.test('nested array edits', async t => {
        await t.test('replicate within item boundary', async t => {
          const { a, b, bus } = t.ctx
          const left = new a.User('nested-arr', {
            items: [{ tags: ['a'] }],
          })
          const right = await b.User.sync('nested-arr')

          left.items[0].tags.push('x')
          await Bus.flush()

          t.assert.deepEqual(right.toJSON(), {
            id: 'nested-arr',
            items: [{ tags: ['a', 'x'] }],
          })

          const delta = bus.a.sent
            .findLast(message =>
              message.event === 'reactive:delta' &&
              message.payload.id === 'nested-arr')
            .payload

          t.assert.equal(delta.path[0], 'items')
          t.assert.equal(delta.path.length, 3)
          t.assert.equal(delta.path[2], 'tags')
          t.assert.equal(delta.op, 'push')
        })
      })

      await t.test('stale ops', async t => {
        await t.test('do not replay after a newer array replacement', async t => {
          const { a, b, bus } = t.ctx
          const left = new a.User('stale-op', { tags: ['a'] })
          const right = await b.User.sync('stale-op')

          right.tags = ['b']
          await Bus.flush()

          bus.b.receive('reactive:delta', {
            class: 'User',
            id: 'stale-op',
            path: ['tags'],
            op: 'push',
            args: ['x'],
            baseVersion: null,
            version: { tick: 1, context: 'older' },
          })
          await Bus.flush()
          await Bus.flush()

          t.assert.deepEqual([...left.tags], ['b'])
          t.assert.deepEqual([...right.tags], ['b'])
        })

        await t.test('do not resurrect removed items', async t => {
          const { a, b, bus } = t.ctx
          const left = new a.User('ghost', {
            items: [{ name: 'A' }, { name: 'B' }],
          })
          const right = await b.User.sync('ghost')

          left.items.splice(0, 1)
          await Bus.flush()

          const before = bus.b.sent.length

          bus.b.receive('reactive:delta', {
            class: 'User',
            id: 'ghost',
            path: ['items', 'removed-id', 'name'],
            value: 'Z',
            version: { tick: 999, context: 'late' },
          })
          await Bus.flush()

          t.assert.equal(right.items.length, 1)
          t.assert.equal(right.items[0].name, 'B')
          t.assert.ok(bus.b.sent.length > before)
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

      await t.test('supports same constructor names with explicit types', async t => {
        const makeRecord = type =>
          class Record extends Reactive {
            static type = type
          }

        const { a: leftBus, b: rightBus } = Bus.createPair()
        const LeftUser = makeRecord('app/User@1')
        const LeftPost = makeRecord('app/Post@1')
        const RightUser = makeRecord('app/User@1')
        const RightPost = makeRecord('app/Post@1')

        LeftUser.use(leftBus)
        LeftPost.use(leftBus)
        RightUser.use(rightBus)
        RightPost.use(rightBus)

        new LeftUser('shared', { name: 'John' })
        new LeftPost('shared', { title: 'Hello' })

        const user = await RightUser.sync('shared')
        const post = await RightPost.sync('shared')

        t.assert.equal(user.name, 'John')
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

    await t.test('rejects duplicate explicit types on one bus', async t => {
      const bus = { on: () => () => {}, send: () => {} }

      class First extends Reactive {
        static type = 'dup/Record@1'
      }

      class Second extends Reactive {
        static type = 'dup/Record@1'
      }

      First.use(bus)

      t.assert.throws(() => Second.use(bus), /already registered/)
    })
  })
})

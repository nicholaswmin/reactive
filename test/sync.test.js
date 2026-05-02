import { test } from 'node:test'

import { Reactive } from '../src/index.js'
import { Bus } from './utils/bus/index.js'
import {
  createContext,
  createLinkedContexts,
} from './utils/context/index.js'

test('Reactive', async t => {
  await t.test('#sync', async t => {
    t.beforeEach(t => {
      t.ctx = createLinkedContexts()
    })

    await t.test('returns existing local instance', async t => {
      const { a } = t.ctx
      const local = new a.User('local', { name: 'John' })

      t.assert.strictEqual(await a.User.sync('local'), local)
    })

    await t.test('remote instance', async t => {
      await t.test('hydrates from snapshot', async t => {
        const { a, b } = t.ctx

        new a.User('sync', {
          name: 'John',
          address: { city: 'London' },
        })

        const remote = await b.User.sync('sync')

        t.assert.strictEqual(remote.name, 'John')
      })

      await t.test('hydrates nested state', async t => {
        const { a, b } = t.ctx

        new a.User('nested', {
          address: { city: 'London' },
        })

        const remote = await b.User.sync('nested')

        t.assert.strictEqual(remote.address.city, 'London')
      })

      await t.test('does not resolve from a non-authoritative shell', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)
        bus.receive('reactive:delta', {
          class: 'User',
          id: 'shell',
          path: ['name'],
          value: 'B',
          version: { tick: 1, context: 'remote' },
        })
        await Bus.flush()

        const pending = User.sync('shell')
        const requestMessage = bus.sent.findLast(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'shell')
        let settled = false

        t.assert.ok(requestMessage)

        pending.finally(() => {
          settled = true
        })
        await Bus.flush()

        t.assert.strictEqual(settled, false)

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'shell',
          requestId: requestMessage.payload.requestId,
          data: { age: 1, name: 'B' },
          refs: [],
          versions: [],
        })

        const remote = await pending

        t.assert.strictEqual(remote.name, 'B')
        t.assert.strictEqual(remote.age, 1)
      })

      await t.test('waits for a matching snapshot response', async t => {
        const { User } = createContext()
        const { b: rightBus } = Bus.createPair()

        User.use(rightBus)

        const pending = User.sync('authoritative')
        const requestMessage = rightBus.sent.at(-1)
        let settled = false

        t.assert.ok(requestMessage)
        const request = requestMessage.payload

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

        t.assert.strictEqual(settled, false)

        rightBus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'authoritative',
          requestId: request.requestId,
          data: { age: 1, name: 'A' },
          refs: [],
          versions: [],
        })

        const remote = await pending

        t.assert.strictEqual(remote.name, 'B')
        t.assert.strictEqual(remote.age, 1)
      })

      await t.test('prefers a later matching snapshot over an earlier missing response', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)

        const pending = User.sync('late')
        const requestMessage = bus.sent.at(-1)
        let settled = false

        t.assert.ok(requestMessage)

        pending.finally(() => {
          settled = true
        })

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'late',
          missing: true,
          requestId: requestMessage.payload.requestId,
        })
        await Bus.flush()

        t.assert.strictEqual(settled, false)

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'late',
          requestId: requestMessage.payload.requestId,
          data: { name: 'A' },
          refs: [],
          versions: [],
        })

        const remote = await pending

        t.assert.strictEqual(remote.name, 'A')
      })

      await t.test('rejects explicit missing responses when unresolved', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.syncTimeoutMs = 10
        User.use(bus)

        try {
          const pending = User.sync('missing')
          const requestMessage = bus.sent.at(-1)

          t.assert.ok(requestMessage)
          const request = requestMessage.payload

          bus.receive('reactive:snapshot:response', {
            class: 'User',
            id: 'missing',
            missing: true,
            requestId: request.requestId,
          })

          await t.assert.rejects(pending, /Unknown User:missing/)
        } finally {
          delete User.syncTimeoutMs
        }
      })

      await t.test('waits for repair snapshot response before resolving', async t => {
        const { a, b, bus } = t.ctx

        new a.User('pending-repair', { tags: ['a'] })
        await b.User.sync('pending-repair')

        bus.b.drop()
        bus.b.receive('reactive:delta', {
          class: 'User',
          id: 'pending-repair',
          path: ['tags'],
          op: 'push',
          args: ['x'],
          baseVersion: { tick: 999, context: 'remote' },
          version: { tick: 1000, context: 'remote' },
        })
        await Bus.flush()

        const requestMessage = bus.b.sent
          .findLast(message =>
            message.event === 'reactive:snapshot:request' &&
            message.payload.id === 'pending-repair')

        t.assert.ok(requestMessage)
        const request = requestMessage.payload
        const pending = b.User.sync('pending-repair')
        let settled = false

        pending.finally(() => {
          settled = true
        })
        await Bus.flush()

        try {
          t.assert.strictEqual(settled, false)
        } finally {
          bus.b.pass()
          bus.b.receive('reactive:snapshot:response', {
            class: 'User',
            id: 'pending-repair',
            requestId: request.requestId,
            data: { tags: ['a'] },
            refs: [],
            versions: [],
          })

          await pending
        }
      })

      await t.test('merges a newer local leaf with an older snapshot object', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)

        const pending = User.sync('nested-merge')
        const requestMessage = bus.sent.at(-1)

        t.assert.ok(requestMessage)
        const request = requestMessage.payload

        bus.receive('reactive:delta', {
          class: 'User',
          id: 'nested-merge',
          path: ['address', 'city'],
          value: 'Berlin',
          version: { tick: 1, context: 'remote' },
        })
        await Bus.flush()

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'nested-merge',
          requestId: request.requestId,
          data: { address: { city: 'London', zip: 'SW1' } },
          refs: [],
          versions: [],
        })

        const remote = await pending

        t.assert.deepStrictEqual(remote.address, {
          city: 'Berlin',
          zip: 'SW1',
        })
      })

      await t.test('keeps a newer local ancestor over an older remote subtree', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)

        const pending = User.sync('ancestor-merge')
        const requestMessage = bus.sent.findLast(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'ancestor-merge')

        t.assert.ok(requestMessage)

        bus.receive('reactive:delta', {
          class: 'User',
          id: 'ancestor-merge',
          path: ['address'],
          value: { city: 'Berlin' },
          version: { tick: 5, context: 'local' },
        })
        await Bus.flush()

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          data: { address: { city: 'Paris', zip: 'SW1' } },
          id: 'ancestor-merge',
          refs: [],
          requestId: requestMessage.payload.requestId,
          versions: [{
            path: ['address'],
            version: { tick: 3, context: 'remote' },
          }],
        })

        const remote = await pending

        t.assert.deepStrictEqual(remote.address, { city: 'Berlin' })
      })

      await t.test('keeps a newer remote ancestor over an older local subtree', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)

        const pending = User.sync('remote-ancestor')
        const requestMessage = bus.sent.findLast(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'remote-ancestor')

        t.assert.ok(requestMessage)

        bus.receive('reactive:delta', {
          class: 'User',
          id: 'remote-ancestor',
          path: ['address', 'city'],
          value: 'Berlin',
          version: { tick: 2, context: 'local' },
        })
        await Bus.flush()

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          data: { address: { city: 'Paris', zip: 'SW1' } },
          id: 'remote-ancestor',
          refs: [],
          requestId: requestMessage.payload.requestId,
          versions: [{
            path: ['address'],
            version: { tick: 5, context: 'remote' },
          }],
        })

        const remote = await pending

        t.assert.deepStrictEqual(remote.address, {
          city: 'Paris',
          zip: 'SW1',
        })
      })

      await t.test('uses the snapshot value on an equal-version merge', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)

        const pending = User.sync('equal-merge')
        const requestMessage = bus.sent.at(-1)

        t.assert.ok(requestMessage)

        bus.receive('reactive:delta', {
          class: 'User',
          id: 'equal-merge',
          path: ['name'],
          value: 'local',
          version: { tick: 1, context: 'same' },
        })
        await Bus.flush()

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'equal-merge',
          requestId: requestMessage.payload.requestId,
          data: { name: 'remote' },
          refs: [],
          versions: [{
            path: ['name'],
            version: { tick: 1, context: 'same' },
          }],
        })

        const remote = await pending

        t.assert.strictEqual(remote.name, 'remote')
      })
    })

    await t.test('pending request lifecycle', async t => {
      await t.test('deduplicates pending sync requests for the same id', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.use(bus)

        const first = User.sync('dedupe')
        const second = User.sync('dedupe')
        const requests = bus.sent.filter(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'dedupe')

        t.assert.strictEqual(first, second)
        t.assert.strictEqual(requests.length, 1)
        t.assert.partialDeepStrictEqual(requests[0].payload, {
          class: 'User',
          id: 'dedupe',
        })
        t.assert.ok(requests[0].payload.requestId)

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          id: 'dedupe',
          requestId: requests[0].payload.requestId,
          data: { name: 'A' },
          refs: [],
          versions: [],
        })

        const [left, right] = await Promise.all([first, second])

        t.assert.strictEqual(left, right)
        t.assert.strictEqual(left.name, 'A')
      })

      await t.test('times out when no authoritative response arrives', async t => {
        const { User } = createContext()
        const { a: bus } = Bus.createPair()

        User.syncTimeoutMs = 10
        User.use(bus)

        const pending = User.sync('timeout')
        const requestMessage = bus.sent.findLast(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'timeout')

        t.assert.ok(requestMessage)
        t.assert.partialDeepStrictEqual(requestMessage.payload, {
          class: 'User',
          id: 'timeout',
        })

        try {
          await t.assert.rejects(pending, /Timed out syncing User:timeout/)
        } finally {
          delete User.syncTimeoutMs
        }
      })

      await t.test('rejects when a live peer reports missing', async t => {
        const { b, bus } = t.ctx

        b.User.syncTimeoutMs = 10

        try {
          await t.assert.rejects(
            b.User.sync('missing-live'),
            /Unknown User:missing-live/
          )
        } finally {
          delete b.User.syncTimeoutMs
        }

        const responseMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:snapshot:response' &&
          message.payload.id === 'missing-live')

        t.assert.ok(responseMessage)
        t.assert.partialDeepStrictEqual(responseMessage.payload, {
          class: 'User',
          id: 'missing-live',
          missing: true,
        })
        t.assert.ok(responseMessage.payload.requestId)
      })
    })
  })

  await t.test('#replication', async t => {
    t.beforeEach(t => {
      t.ctx = createLinkedContexts()
    })

    await t.test('emits outbound deltas with class, id, path, value, and version', async t => {
      const { a, bus } = t.ctx
      const user = new a.User('delta', { name: 'A' })

      user.name = 'B'
      await Bus.flush()

      const deltaMessage = bus.a.sent.at(-1)

      t.assert.ok(deltaMessage)
      t.assert.partialDeepStrictEqual(deltaMessage.payload, {
        class: 'User',
        id: 'delta',
        path: ['name'],
        value: 'B',
      })
      t.assert.ok(Number.isInteger(deltaMessage.payload.version?.tick))
    })

    await t.test('inbound delta', async t => {
      await t.test('applies in place', async t => {
        const { a, b } = t.ctx
        const left = new a.User('apply', { name: 'A' })
        const right = await b.User.sync('apply')

        left.name = 'B'
        await Bus.flush()

        t.assert.strictEqual(right.name, 'B')
      })

      await t.test('applies deletes', async t => {
        const { a, b } = t.ctx
        const left = new a.User('del', { name: 'John', temp: true })
        const right = await b.User.sync('del')

        delete left.temp
        await Bus.flush()

        t.assert.strictEqual('temp' in right, false)
      })

      await t.test('applies direct top-level deletes', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('direct-del', { name: 'John', temp: true })

        bus.a.receive('reactive:delta', {
          class: 'User',
          deleted: true,
          id: 'direct-del',
          path: ['temp'],
          version: { tick: 999, context: 'remote' },
        })
        await Bus.flush()

        t.assert.strictEqual(user.temp, undefined)
        t.assert.strictEqual('temp' in user, false)
      })

      await t.test('applies direct nested deletes', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('direct-nested-del', {
          address: { city: 'London', zip: 'SW1' },
        })

        bus.a.receive('reactive:delta', {
          class: 'User',
          deleted: true,
          id: 'direct-nested-del',
          path: ['address', 'city'],
          version: { tick: 999, context: 'remote' },
        })
        await Bus.flush()

        t.assert.strictEqual(user.address.city, undefined)
        t.assert.strictEqual(user.address.zip, 'SW1')
      })

      await t.test('does not echo back', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('echo', { name: 'A' })

        await b.User.sync('echo')

        bus.b.sent.length = 0
        left.name = 'B'
        await Bus.flush()

        t.assert.strictEqual(bus.b.sent.length, 0)
      })

      await t.test('materializes unknown ids', async t => {
        const { a, b } = t.ctx
        const left = new a.User('late', { name: 'A' })

        left.name = 'B'
        await Bus.flush()

        const right = await b.User.sync('late')

        t.assert.strictEqual(right.name, 'B')
      })

      await t.test('creates arrays for multi-digit index paths', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('index-10', { name: 'A' })

        bus.a.receive('reactive:delta', {
          class: 'User',
          id: 'index-10',
          path: ['grid', '10'],
          value: 'x',
          version: { tick: 999, context: 'remote' },
        })
        await Bus.flush()

        t.assert.ok(Array.isArray(user.grid))
        t.assert.strictEqual(user.grid[0], undefined)
        t.assert.strictEqual(user.grid[10], 'x')
      })

      await t.test('ignores an exact duplicate version on the same path', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('dup-version', { name: 'A' })

        await b.User.sync('dup-version')

        left.name = 'B'
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'dup-version' &&
          message.payload.path.at(-1) === 'name')

        t.assert.ok(deltaMessage)

        bus.b.receive('reactive:delta', {
          class: 'User',
          id: 'dup-version',
          path: ['name'],
          value: 'C',
          version: deltaMessage.payload.version,
        })
        await Bus.flush()

        t.assert.strictEqual(left.name, 'B')
        t.assert.strictEqual((await b.User.sync('dup-version')).name, 'B')
      })

      await t.test('ignores deltas from a foreign class', async t => {
        const { a, bus } = t.ctx

        bus.a.receive('reactive:delta', {
          class: 'Other',
          id: 'foreign',
          path: ['name'],
          value: 'ghost',
          version: { tick: 999, context: 'remote' },
        })
        await Bus.flush()

        const probe = new a.User('foreign', {})

        t.assert.strictEqual(probe.name, undefined)
      })

      await t.test('requests repair when op targets a non-array', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('non-arr', { tags: 'str' })

        const start = bus.a.sent.length

        bus.a.receive('reactive:delta', {
          args: ['x'],
          baseVersion: null,
          class: 'User',
          id: 'non-arr',
          op: 'push',
          path: ['tags'],
          version: { tick: 999, context: 'remote' },
        })
        await Bus.flush()

        const repairMessage = bus.a.sent
          .slice(start)
          .find(message =>
            message.event === 'reactive:snapshot:request' &&
            message.payload.id === 'non-arr')

        t.assert.ok(repairMessage)
        t.assert.strictEqual(user.tags, 'str')
      })

      await t.test('requests repair when op targets an identified list', async t => {
        const { a, b, bus } = t.ctx
        const user = new a.User('id-op', {
          items: [{ name: 'A' }],
        })

        await b.User.sync('id-op')

        const start = bus.b.sent.length

        bus.b.receive('reactive:delta', {
          args: [{ name: 'B' }],
          baseVersion: null,
          class: 'User',
          id: 'id-op',
          op: 'push',
          path: ['items'],
          version: { tick: 999, context: 'remote' },
        })
        await Bus.flush()

        const repairMessage = bus.b.sent
          .slice(start)
          .find(message =>
            message.event === 'reactive:snapshot:request' &&
            message.payload.id === 'id-op')

        t.assert.ok(repairMessage)
        t.assert.strictEqual(user.items.length, 1)
      })
    })

    await t.test('outbound deltas', async t => {
      await t.test('skip when deleting a missing field', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('skip-del', { name: 'A' })
        const start = bus.a.sent.length

        delete user.absent
        await Bus.flush()

        const deltaMessage = bus.a.sent
          .slice(start)
          .find(message =>
            message.event === 'reactive:delta' &&
            message.payload.id === 'skip-del')

        t.assert.strictEqual(deltaMessage, undefined)
      })

      await t.test('replicate an array element delete as a whole-list set', async t => {
        const { a, b, bus } = t.ctx
        const user = new a.User('arr-del', { tags: ['a', 'b', 'c'] })
        const remote = await b.User.sync('arr-del')
        const start = bus.a.sent.length

        delete user.tags[1]
        await Bus.flush()

        const deltaMessage = bus.a.sent
          .slice(start)
          .find(message =>
            message.event === 'reactive:delta' &&
            message.payload.id === 'arr-del')

        t.assert.ok(deltaMessage)
        t.assert.deepStrictEqual(deltaMessage.payload.path, ['tags'])
        t.assert.strictEqual(deltaMessage.payload.deleted, undefined)
        t.assert.strictEqual(deltaMessage.payload.op, undefined)
        t.assert.strictEqual(remote.tags.length, 3)
        t.assert.strictEqual(1 in remote.tags, false)
      })
    })

    await t.test('replicates child refs independently of parent', async t => {
      const { a, b } = t.ctx
      const child = new a.User('child-mut', { name: 'Freida' })

      new a.User('parent-mut', { children: [child] })

      const parent = await b.User.sync('parent-mut')

      child.name = 'Freida Doe'
      await Bus.flush()

      t.assert.strictEqual(parent.children[0].name, 'Freida Doe')
    })

    await t.test('writes propagate in both directions', async t => {
      const { a, b } = t.ctx
      const left = new a.User('bi', { name: 'John', age: 30 })
      const right = await b.User.sync('bi')

      left.name = 'Jane'
      right.age = 31
      await Bus.flush()

      t.assert.strictEqual(right.name, 'Jane')
      t.assert.strictEqual(left.age, 31)
    })

    await t.test('later write wins on the same path', async t => {
      const { a, b } = t.ctx
      const left = new a.User('conflict', { name: 'A' })
      const right = await b.User.sync('conflict')

      left.name = 'X'
      await Bus.flush()
      right.name = 'Y'
      await Bus.flush()

      t.assert.strictEqual(left.name, 'Y')
    })

    await t.test('sibling paths converge on both sides', async t => {
      const { a, b } = t.ctx
      const left = new a.User('sib', {
        address: { city: 'A', zip: '1' },
      })
      const right = await b.User.sync('sib')

      left.address.city = 'London'
      right.address.zip = '99999'
      await Bus.flush()

      const expected = { city: 'London', zip: '99999' }

      t.assert.deepStrictEqual({ ...left.address }, expected)
      t.assert.deepStrictEqual({ ...right.address }, expected)
    })

    await t.test('ancestor and descendant paths', async t => {
      await t.test('newer leaf blocks older ancestor delta', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('ancestor-leaf', {
          address: { city: 'A', zip: '1' },
        })
        const right = await b.User.sync('ancestor-leaf')

        right.address.city = 'London'
        await Bus.flush()

        bus.a.receive('reactive:delta', {
          class: 'User',
          id: 'ancestor-leaf',
          path: ['address'],
          value: { city: 'Paris', zip: '99999' },
          version: { tick: 0, context: 'older' },
        })
        await Bus.flush()

        t.assert.deepStrictEqual(left.address, {
          city: 'London',
          zip: '1',
        })
      })

      await t.test('newer ancestor blocks older leaf delta', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('ancestor-root', {
          address: { city: 'A', zip: '1' },
        })
        const right = await b.User.sync('ancestor-root')

        right.address = { city: 'Berlin', zip: '10115' }
        await Bus.flush()

        bus.a.receive('reactive:delta', {
          class: 'User',
          id: 'ancestor-root',
          path: ['address', 'city'],
          value: 'Paris',
          version: { tick: 0, context: 'older' },
        })
        await Bus.flush()

        t.assert.deepStrictEqual(left.address, {
          city: 'Berlin',
          zip: '10115',
        })
      })

      await t.test('equal ancestor version still allows a descendant delta', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('equal-ancestor', {
          address: { city: 'A', zip: '1' },
        })

        user.address = { city: 'Berlin', zip: '10115' }
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'equal-ancestor' &&
          message.payload.path.length === 1)

        t.assert.ok(deltaMessage)

        bus.a.receive('reactive:delta', {
          class: 'User',
          id: 'equal-ancestor',
          path: ['address', 'city'],
          value: 'Paris',
          version: deltaMessage.payload.version,
        })
        await Bus.flush()

        t.assert.deepStrictEqual(user.address, {
          city: 'Paris',
          zip: '10115',
        })
      })

      await t.test('equal descendant version still allows an ancestor delta', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('equal-descendant', {
          address: { city: 'A', zip: '1' },
        })

        user.address.city = 'Berlin'
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'equal-descendant' &&
          message.payload.path.length === 2)

        t.assert.ok(deltaMessage)

        bus.a.receive('reactive:delta', {
          class: 'User',
          id: 'equal-descendant',
          path: ['address'],
          value: { city: 'Paris', zip: '10115' },
          version: deltaMessage.payload.version,
        })
        await Bus.flush()

        t.assert.deepStrictEqual(user.address, {
          city: 'Paris',
          zip: '10115',
        })
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

        t.assert.deepStrictEqual([...right.tags], ['a', 'z', 'c'])
      })

      await t.test('repairs concurrent pushes to a single converged array', async t => {
        const { a, b } = t.ctx
        const left = new a.User('cpush', { tags: ['a'] })
        const right = await b.User.sync('cpush')

        left.tags.push('x')
        right.tags.push('y')
        await Bus.flush()
        await Bus.flush()

        t.assert.deepStrictEqual([...left.tags], [...right.tags])
        t.assert.strictEqual(left.tags.length, 2)
        t.assert.strictEqual(left.tags[0], 'a')
      })

      await t.test('repair preserves disjoint identified item edits', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('repair-items', {
          items: [{ name: 'A' }, { name: 'B' }],
        })
        const right = await b.User.sync('repair-items')

        bus.a.drop()
        left.items[1].name = 'Y'
        await Bus.flush()

        bus.b.drop()
        right.items[0].name = 'X'
        await Bus.flush()

        bus.a.pass()
        bus.b.pass()
        bus.b.receive('reactive:delta', {
          class: 'User',
          id: 'repair-items',
          path: ['tags'],
          op: 'push',
          args: ['repair'],
          baseVersion: { tick: 999, context: 'remote' },
          version: { tick: 1000, context: 'remote' },
        })
        await Bus.flush()
        await Bus.flush()

        t.assert.deepStrictEqual(
          right.items.map(item => item.name),
          ['X', 'Y']
        )
      })

      await t.test('repair keeps surviving identified edits in snapshot order', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('repair-filter', {
          items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        })
        const right = await b.User.sync('repair-filter')

        bus.a.drop()
        left.items.splice(1, 1)
        await Bus.flush()

        bus.b.drop()
        right.items[1].name = 'B-right'
        right.items[2].name = 'C-right'
        await Bus.flush()

        bus.a.pass()
        bus.b.pass()
        bus.b.receive('reactive:delta', {
          args: ['repair'],
          baseVersion: { context: 'remote', tick: 999 },
          class: 'User',
          id: 'repair-filter',
          op: 'push',
          path: ['tags'],
          version: { context: 'remote', tick: 1000 },
        })
        await Bus.flush()
        await Bus.flush()

        t.assert.deepStrictEqual(
          right.items.map(item => item.name),
          ['A', 'C-right', 'B-right']
        )
      })

      await t.test('emits array op deltas with op and args', async t => {
        const { a, bus } = t.ctx
        const user = new a.User('aop', { tags: ['a'] })

        user.tags.push('b')
        await Bus.flush()

        const deltaMessage = bus.a.sent
          .findLast(message => message.event === 'reactive:delta')

        t.assert.ok(deltaMessage)
        t.assert.partialDeepStrictEqual(deltaMessage.payload, {
          path: ['tags'],
          op: 'push',
          args: ['b'],
        })
        t.assert.strictEqual(deltaMessage.payload.value, undefined)
      })

      await t.test('replicates nested array edits within item boundary', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('nested-arr', {
          items: [{ tags: ['a'] }],
        })
        const right = await b.User.sync('nested-arr')

        left.items[0].tags.push('x')
        await Bus.flush()

        t.assert.deepStrictEqual(right.toJSON(), {
          id: 'nested-arr',
          items: [{ tags: ['a', 'x'] }],
        })

        const deltaMessage = bus.a.sent
          .findLast(message =>
            message.event === 'reactive:delta' &&
            message.payload.id === 'nested-arr')

        t.assert.ok(deltaMessage)
        t.assert.strictEqual(deltaMessage.payload.path[0], 'items')
        t.assert.strictEqual(deltaMessage.payload.path.length, 3)
        t.assert.strictEqual(deltaMessage.payload.path[2], 'tags')
        t.assert.strictEqual(deltaMessage.payload.op, 'push')
      })

      await t.test('replicates an index write inside a nested item array', async t => {
        const { a, b } = t.ctx
        const left = new a.User('nested-idx', {
          items: [{ tags: ['a', 'b'] }],
        })
        const right = await b.User.sync('nested-idx')

        left.items[0].tags[1] = 'x'
        await Bus.flush()

        t.assert.deepStrictEqual(right.items[0].tags, ['a', 'x'])
      })

      await t.test('replicates an item field edit on the receiver', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('item-field', {
          items: [{ name: 'A' }, { name: 'B' }],
        })
        const right = await b.User.sync('item-field')
        const start = bus.b.sent.length

        left.items[1].name = 'Y'
        await Bus.flush()

        const repairMessage = bus.b.sent
          .slice(start)
          .find(message =>
            message.event === 'reactive:snapshot:request' &&
            message.payload.id === 'item-field')

        t.assert.strictEqual(repairMessage, undefined)
        t.assert.strictEqual(right.items[1].name, 'Y')
        t.assert.strictEqual(right.items[0].name, 'A')
      })

      await t.test('replicates deeper nested array mutators as a whole boundary set', async t => {
        const { a, b, bus } = t.ctx
        const left = new a.User('matrix', {
          matrix: [['a'], ['b']],
        })
        const right = await b.User.sync('matrix')

        left.matrix[0].push('x')
        await Bus.flush()

        const deltaMessage = bus.a.sent.findLast(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'matrix')

        t.assert.ok(deltaMessage)
        t.assert.deepStrictEqual(deltaMessage.payload.path, ['matrix'])
        t.assert.strictEqual(deltaMessage.payload.op, undefined)
        t.assert.deepStrictEqual(deltaMessage.payload.value, [['a', 'x'], ['b']])
        t.assert.deepStrictEqual(right.matrix, [['a', 'x'], ['b']])
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

          t.assert.deepStrictEqual([...left.tags], ['b'])
          t.assert.deepStrictEqual([...right.tags], ['b'])
        })

        await t.test('do not resurrect removed items', async t => {
          const { a, b, bus } = t.ctx
          const left = new a.User('ghost', {
            items: [{ name: 'A' }, { name: 'B' }],
          })
          const right = await b.User.sync('ghost')

          left.items.splice(0, 1)
          await Bus.flush()

          const start = bus.b.sent.length

          bus.b.receive('reactive:delta', {
            class: 'User',
            id: 'ghost',
            path: ['items', 'removed-id', 'name'],
            value: 'Z',
            version: { tick: 999, context: 'late' },
          })
          await Bus.flush()

          const repairMessage = bus.b.sent
            .slice(start)
            .find(message =>
              message.event === 'reactive:snapshot:request' &&
              message.payload.id === 'ghost')

          t.assert.strictEqual(right.items.length, 1)
          t.assert.strictEqual(right.items[0].name, 'B')
          t.assert.ok(repairMessage)
          t.assert.partialDeepStrictEqual(repairMessage.payload, {
            class: 'User',
            id: 'ghost',
          })
        })

        await t.test('delete targeting a removed item requests repair', async t => {
          const { a, b, bus } = t.ctx
          const left = new a.User('ghost-del', {
            items: [{ name: 'A' }, { name: 'B' }],
          })
          const right = await b.User.sync('ghost-del')
          const snapshotMessage = bus.a.sent
            .findLast(message =>
              message.event === 'reactive:snapshot:response' &&
              message.payload.id === 'ghost-del')

          t.assert.ok(snapshotMessage)
          const removedId = snapshotMessage.payload.data.items[0].$iid

          left.items.splice(0, 1)
          await Bus.flush()

          const start = bus.b.sent.length

          bus.b.receive('reactive:delta', {
            class: 'User',
            id: 'ghost-del',
            path: ['items', removedId, 'name'],
            deleted: true,
            version: { tick: 999, context: 'late' },
          })
          await Bus.flush()

          const repairMessage = bus.b.sent
            .slice(start)
            .find(message =>
              message.event === 'reactive:snapshot:request' &&
              message.payload.id === 'ghost-del')

          t.assert.strictEqual(right.items.length, 1)
          t.assert.strictEqual(right.items[0].name, 'B')
          t.assert.ok(repairMessage)
          t.assert.partialDeepStrictEqual(repairMessage.payload, {
            class: 'User',
            id: 'ghost-del',
          })
        })
      })
    })

    await t.test('class routing', async t => {
      await t.test('scopes records to class for shared ids', async t => {
        const { a, b } = t.ctx

        new a.User('shared', { name: 'John' })
        new a.Post('shared', { title: 'Hello' })

        const user = await b.User.sync('shared')
        const post = await b.Post.sync('shared')

        t.assert.strictEqual(user.name, 'John')
        t.assert.strictEqual(post.title, 'Hello')
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

        t.assert.strictEqual(user.name, 'John')
        t.assert.strictEqual(post.title, 'Hello')
      })
    })
  })

  await t.test('#use', async t => {
    await t.test('accepts rebinding the same class to the same bus', t => {
      const { User } = createContext()
      const bus = {
        on: t.mock.fn(() => () => {}),
        send: () => {},
      }

      User.use(bus)

      t.assert.doesNotThrow(() => User.use(bus))
    })

    await t.test('ignores bus.on handlers that are not functions', async t => {
      const { User } = createContext()
      const bus = { on: () => undefined, send: () => {} }

      User.use(bus)

      t.assert.doesNotThrow(() => User.use(null))
    })

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

      t.assert.strictEqual(unsubscribe.mock.callCount(), 3)
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

    await t.test('removes a type from the shared registry on unbind', async t => {
      const bus = { on: () => () => {}, send: () => {} }

      class First extends Reactive {
        static type = 'dup/Rebind@1'
      }

      class Second extends Reactive {
        static type = 'dup/Rebind@1'
      }

      First.use(bus)
      First.use(null)

      t.assert.doesNotThrow(() => Second.use(bus))
    })

    await t.test('does not bind classes rejected by duplicate type', async t => {
      const handlers = new Map()
      const sent = []
      const bus = {
        send(event, payload) {
          sent.push({ event, payload })

          for (const handler of handlers.get(event) ?? [])
            handler(payload)
        },
        on(event, handler) {
          const listeners = handlers.get(event) ?? new Set()

          listeners.add(handler)
          handlers.set(event, listeners)

          return () => listeners.delete(handler)
        },
      }

      class First extends Reactive {
        static type = 'dup/Atomic@1'
      }

      class Second extends Reactive {
        static type = 'dup/Atomic@1'
      }

      First.use(bus)
      t.assert.throws(() => Second.use(bus), /already registered/)

      const rejected = new Second('leak', { name: 'local' })

      rejected.name = 'published'

      t.assert.strictEqual(sent.length, 0)
      t.assert.strictEqual(new First('leak', {}).name, undefined)
    })
  })

  await t.test('#clock', async t => {
    await t.test('advances past the highest snapshot version tick', async t => {
      const { User } = createContext()
      const { a: bus } = Bus.createPair()

      User.use(bus)

      const pending = User.sync('clock-high')
      const requestMessage = bus.sent.findLast(message =>
        message.event === 'reactive:snapshot:request' &&
        message.payload.id === 'clock-high')

      t.assert.ok(requestMessage)

      bus.receive('reactive:snapshot:response', {
        class: 'User',
        data: { name: 'A', nick: 'n' },
        id: 'clock-high',
        refs: [],
        requestId: requestMessage.payload.requestId,
        versions: [
          { path: ['name'], version: { tick: 100, context: 'remote' } },
          { path: ['nick'], version: { tick: 50, context: 'remote' } },
        ],
      })

      const remote = await pending

      remote.name = 'B'

      const deltaMessage = bus.sent.findLast(message =>
        message.event === 'reactive:delta' &&
        message.payload.id === 'clock-high')

      t.assert.ok(deltaMessage)
      t.assert.ok(deltaMessage.payload.version.tick > 100)
    })
  })

  await t.test('#wire shape', async t => {
    await t.test('plain object assignments carry no $iid on the wire', async t => {
      const { a, bus } = createLinkedContexts()
      const user = new a.User('no-iid', { address: { city: 'London' } })

      user.address = { city: 'Berlin', zip: '10115' }
      await Bus.flush()

      const deltaMessage = bus.a.sent.findLast(message =>
        message.event === 'reactive:delta' &&
        message.payload.id === 'no-iid' &&
        message.payload.path.at(-1) === 'address')

      t.assert.ok(deltaMessage)
      t.assert.strictEqual(deltaMessage.payload.value.$iid, undefined)
      t.assert.deepStrictEqual(deltaMessage.payload.value, {
        city: 'Berlin',
        zip: '10115',
      })
    })

    await t.test('identified-list index writes emit a whole-list set', async t => {
      const { a, b, bus } = createLinkedContexts()
      const left = new a.User('idx-set', {
        items: [{ name: 'A' }, { name: 'B' }],
      })
      const right = await b.User.sync('idx-set')
      const start = bus.a.sent.length

      left.items[0] = { name: 'Z' }
      await Bus.flush()

      const deltaMessage = bus.a.sent
        .slice(start)
        .find(message =>
          message.event === 'reactive:delta' &&
          message.payload.id === 'idx-set')

      t.assert.ok(deltaMessage)
      t.assert.deepStrictEqual(deltaMessage.payload.path, ['items'])
      t.assert.strictEqual(deltaMessage.payload.op, undefined)
      t.assert.strictEqual(Array.isArray(deltaMessage.payload.value), true)
      t.assert.ok(typeof deltaMessage.payload.value[0].$iid === 'string')
      t.assert.strictEqual(right.items[0].name, 'Z')
    })

    await t.test('non-identified array ops do not tag args with $iid', async t => {
      const { a, bus } = createLinkedContexts()
      const user = new a.User('mixed-push', {
        mixed: [{ a: 1 }, 'plain'],
      })

      user.mixed.push({ b: 2 })
      await Bus.flush()

      const deltaMessage = bus.a.sent.findLast(message =>
        message.event === 'reactive:delta' &&
        message.payload.id === 'mixed-push' &&
        message.payload.op === 'push')

      t.assert.ok(deltaMessage)
      t.assert.strictEqual(deltaMessage.payload.args[0].$iid, undefined)
      t.assert.strictEqual(user.mixed.length, 3)
    })

    await t.test('array ops apply without triggering repair on fresh peers', async t => {
      const { a, b, bus } = createLinkedContexts()
      const left = new a.User('op-live', { tags: ['a'] })
      const right = await b.User.sync('op-live')
      const start = bus.b.sent.length

      left.tags.push('x')
      await Bus.flush()

      const repairMessage = bus.b.sent
        .slice(start)
        .find(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'op-live')

      t.assert.strictEqual(repairMessage, undefined)
      t.assert.deepStrictEqual([...right.tags], ['a', 'x'])
    })
  })

  await t.test('#binding', async t => {
    await t.test('rejects sync without a bound bus', t => {
      const { User } = createContext()

      t.assert.throws(() => User.sync('no-bus'), /without a bus/)
    })
  })

  await t.test('#handlers', async t => {
    await t.test('accepts snapshot responses without a refs field', async t => {
      const { User } = createContext()
      const { a: bus } = Bus.createPair()

      User.use(bus)

      const pending = User.sync('no-refs')
      const requestMessage = bus.sent.findLast(message =>
        message.event === 'reactive:snapshot:request' &&
        message.payload.id === 'no-refs')

      t.assert.ok(requestMessage)

      bus.receive('reactive:snapshot:response', {
        class: 'User',
        data: { name: 'A' },
        id: 'no-refs',
        requestId: requestMessage.payload.requestId,
        versions: [],
      })

      const remote = await pending

      t.assert.strictEqual(remote.name, 'A')
    })

    await t.test('skips refs whose class is not registered', async t => {
      const { User } = createContext()
      const { a: bus } = Bus.createPair()

      User.use(bus)

      const pending = User.sync('orphan-refs')
      const requestMessage = bus.sent.findLast(message =>
        message.event === 'reactive:snapshot:request' &&
        message.payload.id === 'orphan-refs')

      t.assert.ok(requestMessage)

      bus.receive('reactive:snapshot:response', {
        class: 'User',
        data: {
          name: 'P',
          external: { $ref: 'Unregistered', id: 'u1' },
        },
        id: 'orphan-refs',
        refs: [{
          class: 'Unregistered',
          data: { name: 'stranger' },
          id: 'u1',
          versions: [],
        }],
        requestId: requestMessage.payload.requestId,
        versions: [],
      })

      const remote = await pending

      t.assert.strictEqual(remote.name, 'P')
      t.assert.deepStrictEqual(remote.external, {
        $ref: 'Unregistered',
        id: 'u1',
      })
    })

    await t.test('ignores unsolicited snapshot responses', t => {
      const { User } = createContext()
      const { a: bus } = Bus.createPair()

      User.use(bus)

      t.assert.doesNotThrow(() =>
        bus.receive('reactive:snapshot:response', {
          class: 'User',
          data: { name: 'A' },
          id: 'unsolicited',
          refs: [],
          requestId: 'x',
          versions: [],
        }))
    })

    await t.test('ignores snapshot responses with a mismatched requestId', async t => {
      const { User } = createContext()
      const { a: bus } = Bus.createPair()

      User.syncTimeoutMs = 10
      User.use(bus)

      try {
        const pending = User.sync('mis')
        const requestMessage = bus.sent.findLast(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'mis')

        t.assert.ok(requestMessage)

        bus.receive('reactive:snapshot:response', {
          class: 'User',
          data: { name: 'A' },
          id: 'mis',
          refs: [],
          requestId: 'different',
          versions: [],
        })

        await t.assert.rejects(pending, /Timed out syncing User:mis/)
      } finally {
        delete User.syncTimeoutMs
      }
    })

    await t.test('ignores snapshot requests for foreign classes', async t => {
      const { a, b, bus } = createLinkedContexts()

      new a.User('mixed', { name: 'A' })
      await b.User.sync('mixed')

      const postResponses = bus.a.sent.filter(message =>
        message.event === 'reactive:snapshot:response' &&
        message.payload.class === 'Post' &&
        message.payload.id === 'mixed')

      t.assert.strictEqual(postResponses.length, 0)
    })

    await t.test('ignores snapshot responses from foreign classes', async t => {
      const { User } = createContext()
      const { a: bus } = Bus.createPair()

      User.syncTimeoutMs = 10
      User.use(bus)

      try {
        const pending = User.sync('foreign')
        const requestMessage = bus.sent.findLast(message =>
          message.event === 'reactive:snapshot:request' &&
          message.payload.id === 'foreign')

        t.assert.ok(requestMessage)

        bus.receive('reactive:snapshot:response', {
          class: 'Other',
          data: { name: 'A' },
          id: 'foreign',
          refs: [],
          requestId: requestMessage.payload.requestId,
          versions: [],
        })

        await t.assert.rejects(pending, /Timed out syncing User:foreign/)
      } finally {
        delete User.syncTimeoutMs
      }
    })

    await t.test('versions subtree cleared after ancestor write', async t => {
      const { a, b, bus } = createLinkedContexts()
      const user = new a.User('subtree', {
        address: { city: 'London', zip: 'SW1' },
      })

      user.address.city = 'Paris'
      user.address = { city: 'Berlin', zip: '10115' }
      await Bus.flush()
      await b.User.sync('subtree')

      const responseMessage = bus.a.sent.findLast(message =>
        message.event === 'reactive:snapshot:response' &&
        message.payload.id === 'subtree')

      t.assert.ok(responseMessage)

      const paths = responseMessage.payload.versions.map(entry =>
        entry.path.join('/'))

      t.assert.ok(paths.includes('address'))
      t.assert.strictEqual(paths.includes('address/city'), false)
    })
  })
})

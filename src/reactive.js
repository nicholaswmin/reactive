const randomUUID = () => crypto.randomUUID()

const EVENTS = {
  delta: 'reactive:delta',
  request: 'reactive:snapshot:request',
  response: 'reactive:snapshot:response',
}

const ARRAY_MUTATORS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
])

const STORES = new WeakMap()
const REGISTRIES = new WeakMap()
const ROOTS = new WeakMap()
const PROXIES = new WeakMap()
const TARGETS = new WeakMap()
const SEP = '\u001f'

const className = Ctor => Ctor.name
const pathKey = path => path.join(SEP)
const pathFrom = key => key ? key.split(SEP) : []
const graphKey = (Ctor, id) => `${className(Ctor)}:${id}`
const isObject = value => value != null && typeof value === 'object'
const isPlainObject = value => isObject(value) && (
  Object.getPrototypeOf(value) === Object.prototype ||
  Object.getPrototypeOf(value) === null
)
const isContainer = value => Array.isArray(value) || isPlainObject(value)

const compareVersion = (left, right) => {
  if (!left && !right)
    return 0

  if (!left)
    return -1

  if (!right)
    return 1

  if (left.tick !== right.tick)
    return left.tick - right.tick

  return left.context.localeCompare(right.context)
}

const storeFor = Ctor => {
  let store = STORES.get(Ctor)

  if (store)
    return store

  store = {
    bus: null,
    cleanup: [],
    clock: 0,
    context: randomUUID(),
    refs: new Map(),
    snapshots: new Map(),
    waiters: new Map(),
  }

  store.finalizer = new FinalizationRegistry(({ id, refs }) =>
    refs.delete(id)
  )

  STORES.set(Ctor, store)

  return store
}

const rootFor = value => ROOTS.get(value)
const isReactive = value => ROOTS.has(value)
const rawOf = value => TARGETS.get(value) ?? value

const clone = value => {
  if (isReactive(value))
    return value

  const raw = rawOf(value)

  if (Array.isArray(raw))
    return raw.map(clone)

  if (isPlainObject(raw))
    return Object.fromEntries(
      Object.entries(raw).map(([key, child]) => [key, clone(child)])
    )

  return raw
}

const serializeValue = value => {
  if (isReactive(value)) {
    const root = rootFor(value)

    return { $ref: className(root.Ctor), id: root.id }
  }

  const raw = rawOf(value)

  if (Array.isArray(raw))
    return raw.map(serializeValue)

  if (isPlainObject(raw))
    return Object.fromEntries(
      Object.entries(raw).map(([key, child]) => [key, serializeValue(child)])
    )

  return raw
}

const serializeSnapshotValue = (value, visit) => {
  if (isReactive(value)) {
    const root = rootFor(value)

    visit(root)

    return { $ref: className(root.Ctor), id: root.id }
  }

  const raw = rawOf(value)

  if (Array.isArray(raw))
    return raw.map(child => serializeSnapshotValue(child, visit))

  if (isPlainObject(raw))
    return Object.fromEntries(
      Object.entries(raw)
        .map(([key, child]) => [key, serializeSnapshotValue(child, visit)])
    )

  return raw
}

const serializeRecordData = (record, visit = () => {}) =>
  Object.fromEntries(
    Object.entries(record.target)
      .map(([key, value]) => [key, serializeSnapshotValue(value, visit)])
  )

const serializeVersions = versions =>
  [...versions.entries()].map(([key, version]) => ({
    path: pathFrom(key),
    version,
  }))

const versionsFrom = entries =>
  new Map(entries.map(({ path, version }) => [pathKey(path), version]))

const snapshotFor = record => ({
  data: serializeRecordData(record),
  versions: serializeVersions(record.versions),
})

const storeSnapshot = record => {
  record.store.snapshots.set(record.id, snapshotFor(record))
}

const buildSnapshotGraph = record => {
  const refs = []
  const seen = new Set()

  const visit = current => {
    const key = graphKey(current.Ctor, current.id)

    if (seen.has(key))
      return

    seen.add(key)

    refs.push({
      class: className(current.Ctor),
      id: current.id,
      data: serializeRecordData(current, visit),
      versions: serializeVersions(current.versions),
    })
  }

  const root = {
    class: className(record.Ctor),
    id: record.id,
    data: serializeRecordData(record, visit),
    versions: serializeVersions(record.versions),
  }

  return { ...root, refs }
}

const rememberVersion = (record, path, version) => {
  const key = pathKey(path)
  const prefix = key ? `${key}${SEP}` : ''

  for (const existing of [...record.versions.keys()]) {
    if (existing === key || existing.startsWith(prefix))
      record.versions.delete(existing)
  }

  record.versions.set(key, version)

  if (record.store.clock < version.tick)
    record.store.clock = version.tick
}

const newerAncestor = (record, path, version) =>
  path.some((_, index) =>
    compareVersion(
      record.versions.get(pathKey(path.slice(0, index))),
      version
    ) > 0
  )

const newerDescendant = (record, path, version) => {
  const key = pathKey(path)
  const prefix = key ? `${key}${SEP}` : ''

  for (const [entry, current] of record.versions) {
    if ((entry === key || entry.startsWith(prefix)) &&
      compareVersion(current, version) > 0)
      return true
  }

  return false
}

const nextVersion = store => ({
  tick: ++store.clock,
  context: store.context,
})

const eventPath = (target, path, emit, prop) =>
  Array.isArray(target) || pathKey(path) !== pathKey(emit)
    ? emit
    : [...path, String(prop)]

const valueAtPath = (target, path) =>
  path.reduce((value, segment) => rawOf(value?.[segment]), target)

const setAtPath = (target, path, value) => {
  if (path.length === 1) {
    target[path[0]] = value
    return
  }

  let cursor = target

  for (const [index, segment] of path.slice(0, -1).entries()) {
    const next = path[index + 1]
    const current = rawOf(cursor[segment])

    if (!isContainer(current))
      cursor[segment] = /^\d+$/.test(next) ? [] : {}

    cursor = rawOf(cursor[segment])
  }

  cursor[path.at(-1)] = value
}

const deleteAtPath = (target, path) => {
  if (path.length === 1) {
    delete target[path[0]]
    return
  }

  const parent = valueAtPath(target, path.slice(0, -1))

  if (parent && typeof parent === 'object')
    delete parent[path.at(-1)]
}

const resolveWaiters = (store, id, value) => {
  const waiters = store.waiters.get(id) ?? []

  store.waiters.delete(id)

  for (const resolve of waiters)
    resolve(value)
}

const liveFor = (Ctor, id) => {
  const store = storeFor(Ctor)
  const ref = store.refs.get(id)
  const value = ref?.deref()

  if (!value)
    store.refs.delete(id)

  return value
}

const createRecord = (Ctor, id) => {
  const store = storeFor(Ctor)
  const target = Object.create(Ctor.prototype)
  const record = {
    Ctor,
    id,
    proxy: null,
    store,
    target,
    versions: new Map(),
  }

  const proxy = proxify(target, record, [], [])

  record.proxy = proxy

  ROOTS.set(target, record)
  ROOTS.set(proxy, record)
  TARGETS.set(proxy, target)

  store.refs.set(id, new WeakRef(proxy))
  store.finalizer.register(proxy, { id, refs: store.refs }, proxy)
  storeSnapshot(record)

  return record
}

const recordForId = (Ctor, id) => {
  const live = liveFor(Ctor, id)

  if (live)
    return rootFor(live)

  return createRecord(Ctor, id)
}

const hydrate = (value, registry) => {
  if (!isObject(value))
    return value

  if ('$ref' in value && 'id' in value) {
    const Ctor = registry?.get(value.$ref)

    if (!Ctor)
      return value

    return recordForId(Ctor, value.id).proxy
  }

  if (Array.isArray(value))
    return value.map(child => hydrate(child, registry))

  if (isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, child]) => [key, hydrate(child, registry)])
    )

  return value
}

const replaceState = (record, data, versions = []) => {
  for (const key of Object.keys(record.target))
    delete record.target[key]

  for (const [key, value] of Object.entries(data))
    record.target[key] = hydrate(value, record.store.registry)

  record.versions = versions instanceof Map
    ? new Map(versions)
    : versionsFrom(versions)

  for (const version of record.versions.values()) {
    if (record.store.clock < version.tick)
      record.store.clock = version.tick
  }

  storeSnapshot(record)
}

const localSet = (record, path, value) => {
  const version = nextVersion(record.store)

  rememberVersion(record, path, version)
  storeSnapshot(record)

  record.store.bus?.send(EVENTS.delta, {
    class: className(record.Ctor),
    id: record.id,
    path,
    value: serializeValue(value),
    version,
  })
}

const localOp = (record, path, op, args) => {
  const version = nextVersion(record.store)

  rememberVersion(record, path, version)
  storeSnapshot(record)

  record.store.bus?.send(EVENTS.delta, {
    class: className(record.Ctor),
    id: record.id,
    path,
    op,
    args: args.map(serializeValue),
    version,
  })
}

const localDelete = (record, path) => {
  const version = nextVersion(record.store)

  rememberVersion(record, path, version)
  storeSnapshot(record)

  record.store.bus?.send(EVENTS.delta, {
    class: className(record.Ctor),
    deleted: true,
    id: record.id,
    path,
    version,
  })
}

const applyRemoteSet = (record, path, value, version) => {
  if (
    compareVersion(record.versions.get(pathKey(path)), version) >= 0 ||
    newerAncestor(record, path, version) ||
    newerDescendant(record, path, version)
  )
    return

  setAtPath(record.target, path, hydrate(value, record.store.registry))
  rememberVersion(record, path, version)
  storeSnapshot(record)
}

const applyRemoteDelete = (record, path, version) => {
  if (
    compareVersion(record.versions.get(pathKey(path)), version) >= 0 ||
    newerAncestor(record, path, version) ||
    newerDescendant(record, path, version)
  )
    return

  deleteAtPath(record.target, path)
  rememberVersion(record, path, version)
  storeSnapshot(record)
}

const applyRemoteOp = (record, path, op, args, version) => {
  const target = valueAtPath(record.target, path)

  if (!Array.isArray(target))
    return

  Array.prototype[op].apply(
    target, args.map(a => hydrate(a, record.store.registry))
  )
  rememberVersion(record, path, version)
  storeSnapshot(record)
}

const applySnapshotMessage = (message, registry) => {
  const rootCtor = registry.get(message.class)

  if (!rootCtor)
    return null

  recordForId(rootCtor, message.id)

  for (const ref of message.refs ?? []) {
    const Ctor = registry.get(ref.class)

    if (!Ctor)
      continue

    replaceState(recordForId(Ctor, ref.id), ref.data, ref.versions)
  }

  const root = recordForId(rootCtor, message.id)

  replaceState(root, message.data, message.versions)

  return root.proxy
}

const handleDelta = (Ctor, message) => {
  if (message.class !== className(Ctor))
    return

  const record = recordForId(Ctor, message.id)

  if (message.deleted)
    applyRemoteDelete(record, message.path, message.version)
  else if (message.op)
    applyRemoteOp(record, message.path, message.op, message.args, message.version)
  else
    applyRemoteSet(record, message.path, message.value, message.version)

  resolveWaiters(record.store, record.id, record.proxy)
}

const handleRequest = (Ctor, message) => {
  if (message.class !== className(Ctor))
    return

  const live = liveFor(Ctor, message.id)
  const snapshot = live
    ? buildSnapshotGraph(rootFor(live))
    : storeFor(Ctor).snapshots.get(message.id)

  if (!snapshot)
    return

  storeFor(Ctor).bus?.send(EVENTS.response, {
    ...snapshot,
    class: className(Ctor),
    id: message.id,
    requestId: message.requestId,
  })
}

const handleResponse = (Ctor, message) => {
  if (message.class !== className(Ctor))
    return

  const instance = applySnapshotMessage(message, storeFor(Ctor).registry)

  if (instance)
    resolveWaiters(storeFor(Ctor), message.id, instance)
}

const proxify = (target, record, path, emit) => {
  const existing = PROXIES.get(target)

  if (existing)
    return existing

  const proxy = new Proxy(target, {
    deleteProperty(target, prop) {
      const existed = Reflect.has(target, prop)
      const deleted = Reflect.deleteProperty(target, prop)

      if (!deleted || !existed)
        return deleted

      const next = eventPath(target, path, emit, prop)

      if (pathKey(next) === pathKey(emit) && (
        Array.isArray(target) || pathKey(path) !== pathKey(emit)
      ))
        localSet(record, emit, valueAtPath(record.target, emit))
      else
        localDelete(record, next)

      return true
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      if (
        Array.isArray(target) &&
        typeof prop === 'string' &&
        ARRAY_MUTATORS.has(prop)
      )
        return (...args) => {
          const cloned = args.map(clone)
          const result = Array.prototype[prop].apply(target, cloned)

          localOp(record, emit, prop, cloned)

          return result
        }

      if (!isContainer(rawOf(value)))
        return value

      const nextPath = [...path, String(prop)]
      const nextEmit = Array.isArray(target) || pathKey(path) !== pathKey(emit)
        ? emit
        : nextPath

      return proxify(rawOf(value), record, nextPath, nextEmit)
    },
    set(target, prop, value, receiver) {
      const next = clone(value)
      const changed = Reflect.set(target, prop, next, receiver)

      if (!changed)
        return false

      const mutation = eventPath(target, path, emit, prop)

      if (pathKey(mutation) === pathKey(emit) && (
        Array.isArray(target) || pathKey(path) !== pathKey(emit)
      ))
        localSet(record, emit, valueAtPath(record.target, emit))
      else
        localSet(record, mutation, next)

      return true
    },
  })

  PROXIES.set(target, proxy)
  TARGETS.set(proxy, target)

  return proxy
}

const parseArgs = (id, data) =>
  typeof id === 'string'
    ? { data: data ?? {}, id }
    : { data: id ?? {}, id: randomUUID() }

export class Reactive {
  constructor(id, data) {
    const Ctor = new.target
    const { data: state, id: value } = parseArgs(id, data)

    storeFor(Ctor)

    const existing = liveFor(Ctor, value)

    if (existing)
      return existing

    const record = createRecord(Ctor, value)

    replaceState(record, clone(state), [])

    return record.proxy
  }

  static sync(id) {
    const Ctor = this
    const live = liveFor(Ctor, id)

    if (live)
      return Promise.resolve(live)

    const store = storeFor(Ctor)
    const snapshot = store.snapshots.get(id)

    if (snapshot) {
      const record = recordForId(Ctor, id)

      replaceState(record, snapshot.data, snapshot.versions)

      return Promise.resolve(record.proxy)
    }

    if (!store.bus)
      throw new Error(`Cannot sync ${className(Ctor)} without a bus`)

    const waiting = store.waiters.get(id) ?? []

    store.waiters.set(id, waiting)

    const promise = new Promise(resolve => waiting.push(resolve))

    store.bus.send(EVENTS.request, {
      class: className(Ctor),
      id,
      requestId: randomUUID(),
    })

    return promise
  }

  static use(bus) {
    const store = storeFor(this)

    for (const cleanup of store.cleanup)
      cleanup()

    store.bus = bus
    store.cleanup = []

    if (bus) {
      const registry = REGISTRIES.get(bus) ?? new Map()

      REGISTRIES.set(bus, registry)
      registry.set(className(this), this)
      store.registry = registry
    }

    if (!bus?.on)
      return

    for (const [event, handler] of [
      [EVENTS.delta, message => handleDelta(this, message)],
      [EVENTS.request, message => handleRequest(this, message)],
      [EVENTS.response, message => handleResponse(this, message)],
    ]) {
      const cleanup = bus.on(event, handler)

      if (typeof cleanup === 'function')
        store.cleanup.push(cleanup)
    }
  }

  get id() {
    return rootFor(this)?.id
  }

  toJSON() {
    const record = rootFor(this)

    return {
      id: record.id,
      ...Object.fromEntries(
        Object.entries(record.target)
          .map(([key, value]) => [key, serializeValue(value)])
      ),
    }
  }
}

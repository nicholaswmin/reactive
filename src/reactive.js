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

const SNAPSHOT_LIMIT = 1_000
const SYNC_TIMEOUT_MS = 5_000
const STALE_REFERENCE_ERROR = 'Stale reactive reference'

const STORES = new WeakMap()
const REGISTRIES = new WeakMap()
const ROOTS = new WeakMap()
const PROXIES = new WeakMap()
const TARGETS = new WeakMap()
const SEP = '\u001f'
const ITEM_ID = Symbol('reactive:item-id')

class IdentifiedList extends Array {
  static get [Symbol.species]() { return Array }
}

const assignItemId = (obj, id) =>
  Object.defineProperty(obj, ITEM_ID, { value: id })

const ensureItemId = obj => {
  if (!obj[ITEM_ID])
    assignItemId(obj, randomUUID())
}

const typeId = Ctor => {
  const value = Ctor.type ?? Ctor.name

  if (typeof value !== 'string' || value === '')
    throw new Error('Reactive type must be a non-empty string')

  return value
}

const pathKey = path => path.join(SEP)
const pathFrom = key => key ? key.split(SEP) : []
const graphKey = (type, id) => `${type}:${id}`
const samePath = (left, right) => pathKey(left) === pathKey(right)
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

const strongerVersion = (left, right) =>
  compareVersion(left, right) >= 0 ? left : right

const cloneVersions = versions => new Map(versions)

const cloneData = value => {
  if (Array.isArray(value))
    return value.map(cloneData)

  if (isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneData(child)])
    )

  return value
}

const storeFor = Ctor => {
  let store = STORES.get(Ctor)

  if (store)
    return store

  const type = typeId(Ctor)

  store = {
    bus: null,
    cleanup: [],
    clock: 0,
    context: randomUUID(),
    pending: new Map(),
    refs: new Map(),
    registry: new Map([[type, Ctor]]),
    snapshotClock: 0,
    snapshots: new Map(),
    type,
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

  if (Array.isArray(raw)) {
    const items = raw.map(clone)

    if (items.length && items.every(isPlainObject)) {
      const list = new IdentifiedList()

      for (const item of items) {
        ensureItemId(item)
        Array.prototype.push.call(list, item)
      }

      return list
    }

    return items
  }

  if (isPlainObject(raw)) {
    const cloned = Object.fromEntries(
      Object.entries(raw).map(([key, child]) => [key, clone(child)])
    )

    if (raw[ITEM_ID])
      assignItemId(cloned, raw[ITEM_ID])

    return cloned
  }

  return raw
}

const serializeValue = (value, wire = false) => {
  if (isReactive(value)) {
    const root = rootFor(value)

    return { $ref: typeId(root.Ctor), id: root.id }
  }

  const raw = rawOf(value)

  if (Array.isArray(raw))
    return raw.map(child => serializeValue(child, wire))

  if (isPlainObject(raw)) {
    const entries = Object.entries(raw)
      .map(([key, child]) => [key, serializeValue(child, wire)])

    if (wire && raw[ITEM_ID])
      entries.push(['$iid', raw[ITEM_ID]])

    return Object.fromEntries(entries)
  }

  return raw
}

const serializeSnapshotValue = (value, visit) => {
  if (isReactive(value)) {
    const root = rootFor(value)

    visit(root)

    return { $ref: typeId(root.Ctor), id: root.id }
  }

  const raw = rawOf(value)

  if (Array.isArray(raw))
    return raw.map(child => serializeSnapshotValue(child, visit))

  if (isPlainObject(raw)) {
    const entries = Object.entries(raw)
      .map(([key, child]) => [key, serializeSnapshotValue(child, visit)])

    if (raw[ITEM_ID])
      entries.push(['$iid', raw[ITEM_ID]])

    return Object.fromEntries(entries)
  }

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
  complete: record.complete,
  data: serializeRecordData(record),
  order: ++record.store.snapshotClock,
  versions: cloneVersions(record.versions),
})

const trimSnapshots = store => {
  while (store.snapshots.size > SNAPSHOT_LIMIT) {
    let oldestId = null
    let oldestOrder = Infinity

    for (const [id, snapshot] of store.snapshots) {
      if (snapshot.order < oldestOrder) {
        oldestId = id
        oldestOrder = snapshot.order
      }
    }

    if (oldestId == null)
      return

    store.snapshots.delete(oldestId)
  }
}

const storeSnapshot = record => {
  record.store.snapshots.set(record.id, snapshotFor(record))
  trimSnapshots(record.store)
}

const snapshotMessageFor = (Ctor, id, snapshot) => ({
  class: typeId(Ctor),
  data: cloneData(snapshot.data),
  id,
  versions: serializeVersions(snapshot.versions),
})

const collectSnapshotRefs = (value, visit) => {
  if (!isObject(value))
    return true

  if ('$ref' in value && 'id' in value)
    return visit(value.$ref, value.id)

  if (Array.isArray(value))
    return value.every(child => collectSnapshotRefs(child, visit))

  if (isPlainObject(value))
    return Object.values(value)
      .every(child => collectSnapshotRefs(child, visit))

  return true
}

const buildCachedSnapshotGraph = (Ctor, id, registry) => {
  const store = storeFor(Ctor)
  const rootSnapshot = store.snapshots.get(id)

  if (!rootSnapshot?.complete)
    return null

  const refs = []
  const seen = new Set([graphKey(store.type, id)])

  const visit = (type, refId) => {
    const key = graphKey(type, refId)

    if (seen.has(key))
      return true

    seen.add(key)

    const RefCtor = registry?.get(type)

    if (!RefCtor)
      return false

    const snapshot = storeFor(RefCtor).snapshots.get(refId)

    if (!snapshot?.complete)
      return false

    refs.push(snapshotMessageFor(RefCtor, refId, snapshot))

    return collectSnapshotRefs(snapshot.data, visit)
  }

  if (!collectSnapshotRefs(rootSnapshot.data, visit))
    return null

  return {
    ...snapshotMessageFor(Ctor, id, rootSnapshot),
    refs,
  }
}

const buildSnapshotGraph = record => {
  const refs = []
  const seen = new Set([graphKey(typeId(record.Ctor), record.id)])

  const visit = current => {
    const type = typeId(current.Ctor)
    const key = graphKey(type, current.id)

    if (seen.has(key))
      return

    seen.add(key)

    refs.push({
      class: type,
      data: serializeRecordData(current, visit),
      id: current.id,
      versions: serializeVersions(current.versions),
    })
  }

  return {
    class: typeId(record.Ctor),
    data: serializeRecordData(record, visit),
    id: record.id,
    refs,
    versions: serializeVersions(record.versions),
  }
}

const setVersion = (versions, path, version) => {
  const key = pathKey(path)
  const prefix = key ? `${key}${SEP}` : ''

  for (const existing of [...versions.keys()]) {
    if (existing === key || existing.startsWith(prefix))
      versions.delete(existing)
  }

  versions.set(key, version)
}

const rememberVersion = (record, path, version) => {
  setVersion(record.versions, path, version)

  if (record.store.clock < version.tick)
    record.store.clock = version.tick
}

const versionAt = (versions, path) => {
  for (let index = path.length; index >= 0; index--) {
    const version = versions.get(pathKey(path.slice(0, index)))

    if (version)
      return version
  }

  return null
}

const newestVersionInSubtree = (versions, path) => {
  const key = pathKey(path)
  const prefix = key ? `${key}${SEP}` : ''
  let newest = null

  for (const [entry, version] of versions) {
    if (entry === key || entry.startsWith(prefix))
      newest = strongerVersion(newest, version)
  }

  return newest
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

const valueAtPath = (target, path) =>
  path.reduce((cursor, segment) => {
    const raw = rawOf(cursor)

    if (raw instanceof IdentifiedList && !/^\d+$/.test(segment))
      return raw.find(el => el?.[ITEM_ID] === segment)

    return rawOf(raw?.[segment])
  }, target)

const setAtPath = (target, path, value) => {
  if (path.length === 1) {
    target[path[0]] = value
    return
  }

  let cursor = target

  for (const [index, segment] of path.slice(0, -1).entries()) {
    const raw = rawOf(cursor)

    if (raw instanceof IdentifiedList && !/^\d+$/.test(segment)) {
      cursor = raw.find(el => el?.[ITEM_ID] === segment)

      if (!cursor)
        return

      continue
    }

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

const liveFor = (Ctor, id) => {
  const store = storeFor(Ctor)
  const ref = store.refs.get(id)
  const value = ref?.deref()

  if (!value)
    store.refs.delete(id)

  return value
}

const resolvePathExists = (target, path) => {
  let cursor = target

  for (let i = 0; i < path.length - 1; i++) {
    const raw = rawOf(cursor)
    const segment = path[i]

    if (raw instanceof IdentifiedList && !/^\d+$/.test(segment)) {
      cursor = raw.find(el => el?.[ITEM_ID] === segment)

      if (!cursor)
        return false
    } else {
      cursor = raw?.[segment]
    }
  }

  return true
}

const requestRepair = record => {
  if (!record.store.bus)
    return

  requestSnapshot(record.Ctor, record.id).catch(() => {})
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

  if (Array.isArray(value)) {
    const items = value.map(child => hydrate(child, registry))

    if (items.length && items.every(isPlainObject)) {
      const list = new IdentifiedList()

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const wire = value[i]?.$iid

        if (wire)
          assignItemId(item, wire)
        else
          ensureItemId(item)

        delete item.$iid
        Array.prototype.push.call(list, item)
      }

      return list
    }

    return items
  }

  if (isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, child]) => [key, hydrate(child, registry)])
    )

  return value
}

const replaceState = (record, data, versions = [], complete = record.complete) => {
  for (const key of Object.keys(record.target))
    delete record.target[key]

  for (const [key, value] of Object.entries(data))
    record.target[key] = hydrate(value, record.store.registry)

  record.complete = complete
  record.versions = versions instanceof Map
    ? cloneVersions(versions)
    : versionsFrom(versions)

  for (const version of record.versions.values()) {
    if (record.store.clock < version.tick)
      record.store.clock = version.tick
  }

  storeSnapshot(record)
}

const mergeSnapshotValue = (
  path,
  localValue,
  remoteValue,
  localVersions,
  remoteVersions,
  mergedVersions,
) => {
  const key = pathKey(path)
  const localExact = localVersions.get(key)
  const remoteExact = remoteVersions.get(key)
  const localSubtree = newestVersionInSubtree(localVersions, path)
  const remoteSubtree = newestVersionInSubtree(remoteVersions, path)

  if (localExact && compareVersion(localExact, remoteSubtree) > 0) {
    setVersion(mergedVersions, path, localExact)
    return cloneData(localValue)
  }

  if (remoteExact && compareVersion(remoteExact, localSubtree) > 0) {
    setVersion(mergedVersions, path, remoteExact)
    return cloneData(remoteValue)
  }

  const exact = strongerVersion(localExact, remoteExact)

  if (exact)
    setVersion(mergedVersions, path, exact)

  if (Array.isArray(localValue) || Array.isArray(remoteValue)) {
    const choice = compareVersion(localSubtree, remoteSubtree)

    if (choice > 0)
      return cloneData(localValue)

    if (choice < 0)
      return cloneData(remoteValue)

    return cloneData(remoteValue ?? localValue)
  }

  if (isPlainObject(localValue) && isPlainObject(remoteValue)) {
    const merged = {}
    const keys = new Set([
      ...Object.keys(localValue),
      ...Object.keys(remoteValue),
    ])

    for (const childKey of keys) {
      const value = mergeSnapshotValue(
        [...path, childKey],
        localValue[childKey],
        remoteValue[childKey],
        localVersions,
        remoteVersions,
        mergedVersions,
      )

      if (value !== undefined)
        merged[childKey] = value
    }

    return merged
  }

  const choice = compareVersion(localSubtree, remoteSubtree)

  if (choice > 0)
    return cloneData(localValue)

  if (choice < 0)
    return cloneData(remoteValue)

  if (remoteValue !== undefined)
    return cloneData(remoteValue)

  return cloneData(localValue)
}

const mergeSnapshotState = (record, data, versions) => {
  const mergedVersions = new Map()
  const mergedData = mergeSnapshotValue(
    [],
    serializeRecordData(record),
    data,
    record.versions,
    versions,
    mergedVersions,
  )

  return {
    data: isPlainObject(mergedData) ? mergedData : {},
    versions: mergedVersions,
  }
}

const applySnapshotState = (record, data, versions) => {
  const remoteVersions = versions instanceof Map
    ? versions
    : versionsFrom(versions)

  const next = mergeSnapshotState(record, data, remoteVersions)

  replaceState(record, next.data, next.versions, true)
}

const emitDelta = (record, payload) =>
  record.store.bus?.send(EVENTS.delta, {
    class: record.store.type,
    id: record.id,
    ...payload,
  })

const localSet = (record, path, value) => {
  const version = nextVersion(record.store)

  rememberVersion(record, path, version)
  storeSnapshot(record)
  emitDelta(record, {
    path,
    value: serializeValue(value, true),
    version,
  })
}

const localOp = (record, path, op, args, baseVersion) => {
  const version = nextVersion(record.store)

  rememberVersion(record, path, version)
  storeSnapshot(record)
  emitDelta(record, {
    args: args.map(arg => serializeValue(arg, true)),
    baseVersion,
    op,
    path,
    version,
  })
}

const localDelete = (record, path) => {
  const version = nextVersion(record.store)

  rememberVersion(record, path, version)
  storeSnapshot(record)
  emitDelta(record, {
    deleted: true,
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
    return false

  if (!resolvePathExists(record.target, path)) {
    requestRepair(record)
    return false
  }

  setAtPath(record.target, path, hydrate(value, record.store.registry))
  rememberVersion(record, path, version)
  storeSnapshot(record)

  return true
}

const applyRemoteDelete = (record, path, version) => {
  if (
    compareVersion(record.versions.get(pathKey(path)), version) >= 0 ||
    newerAncestor(record, path, version) ||
    newerDescendant(record, path, version)
  )
    return false

  deleteAtPath(record.target, path)
  rememberVersion(record, path, version)
  storeSnapshot(record)

  return true
}

const applyRemoteOp = (record, path, op, args, baseVersion, version) => {
  const currentVersion = versionAt(record.versions, path)

  if (
    compareVersion(currentVersion, version) >= 0 ||
    newerAncestor(record, path, version) ||
    newerDescendant(record, path, version)
  )
    return false

  if (compareVersion(currentVersion, baseVersion) !== 0) {
    requestRepair(record)
    return false
  }

  const target = valueAtPath(record.target, path)

  if (!Array.isArray(target)) {
    if (compareVersion(currentVersion, version) < 0)
      requestRepair(record)

    return false
  }

  if (target instanceof IdentifiedList) {
    requestRepair(record)
    return false
  }

  Array.prototype[op].apply(
    target,
    args.map(arg => hydrate(arg, record.store.registry))
  )
  rememberVersion(record, path, version)
  storeSnapshot(record)

  return true
}

const applySnapshotMessage = (message, registry) => {
  const rootCtor = registry.get(message.class)

  if (!rootCtor)
    return null

  const root = recordForId(rootCtor, message.id)

  for (const ref of message.refs ?? []) {
    const Ctor = registry.get(ref.class)

    if (Ctor)
      recordForId(Ctor, ref.id)
  }

  for (const ref of message.refs ?? []) {
    const Ctor = registry.get(ref.class)

    if (Ctor)
      applySnapshotState(recordForId(Ctor, ref.id), ref.data, ref.versions)
  }

  applySnapshotState(root, message.data, message.versions)

  return root.proxy
}

const createRecord = (Ctor, id) => {
  const store = storeFor(Ctor)
  const target = Object.create(Ctor.prototype)
  const record = {
    Ctor,
    complete: false,
    id,
    proxy: null,
    store,
    target,
    versions: new Map(),
  }

  const proxy = proxify(target, record, [], null)

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

const clearPending = (store, id) => {
  const pending = store.pending.get(id)

  if (!pending)
    return null

  store.pending.delete(id)
  clearTimeout(pending.timer)

  return pending
}

const requestSnapshot = (Ctor, id) => {
  const store = storeFor(Ctor)
  const existing = store.pending.get(id)

  if (existing)
    return existing.promise

  if (!store.bus)
    throw new Error(`Cannot sync ${store.type} without a bus`)

  const requestId = randomUUID()
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  const timeoutMs = Number.isInteger(Ctor.syncTimeoutMs)
    ? Ctor.syncTimeoutMs
    : SYNC_TIMEOUT_MS
  const timer = setTimeout(() => {
    const pending = clearPending(store, id)

    if (pending)
      pending.reject(new Error(`Timed out syncing ${store.type}:${id}`))
  }, timeoutMs)

  store.pending.set(id, {
    promise,
    reject,
    requestId,
    resolve,
    timer,
  })

  store.bus.send(EVENTS.request, {
    class: store.type,
    id,
    requestId,
  })

  return promise
}

const handleDelta = (Ctor, message) => {
  const store = storeFor(Ctor)

  if (message.class !== store.type)
    return

  const record = recordForId(Ctor, message.id)

  if (message.deleted)
    applyRemoteDelete(record, message.path, message.version)
  else if (message.op)
    applyRemoteOp(
      record,
      message.path,
      message.op,
      message.args,
      message.baseVersion,
      message.version,
    )
  else
    applyRemoteSet(record, message.path, message.value, message.version)
}

const handleRequest = (Ctor, message) => {
  const store = storeFor(Ctor)

  if (message.class !== store.type)
    return

  const live = liveFor(Ctor, message.id)
  const liveRecord = live ? rootFor(live) : null
  const snapshot = liveRecord?.complete
    ? buildSnapshotGraph(liveRecord)
    : buildCachedSnapshotGraph(Ctor, message.id, store.registry)

  store.bus?.send(EVENTS.response, snapshot
    ? {
        ...snapshot,
        requestId: message.requestId,
      }
    : {
        class: store.type,
        id: message.id,
        missing: true,
        requestId: message.requestId,
      })
}

const handleResponse = (Ctor, message) => {
  const store = storeFor(Ctor)

  if (message.class !== store.type)
    return

  const pending = store.pending.get(message.id)

  if (!pending || pending.requestId !== message.requestId)
    return

  clearPending(store, message.id)

  if (message.missing) {
    pending.reject(new Error(`Unknown ${store.type}:${message.id}`))
    return
  }

  const instance = applySnapshotMessage(message, store.registry)

  if (!instance) {
    pending.reject(new Error(`Cannot hydrate ${store.type}:${message.id}`))
    return
  }

  pending.resolve(instance)
}

const assertLiveTarget = (record, path, target) => {
  if (!path.length)
    return

  if (rawOf(valueAtPath(record.target, path)) !== target)
    throw new Error(STALE_REFERENCE_ERROR)
}

const replicateBoundary = (record, boundary) =>
  localSet(record, boundary, valueAtPath(record.target, boundary))

const proxify = (target, record, path, boundary) => {
  const existing = PROXIES.get(target)

  if (existing)
    return existing

  const proxy = new Proxy(target, {
    deleteProperty(target, prop) {
      assertLiveTarget(record, path, target)

      const existed = Reflect.has(target, prop)
      const deleted = Reflect.deleteProperty(target, prop)

      if (!deleted || !existed)
        return deleted

      if (boundary)
        replicateBoundary(record, boundary)
      else
        localDelete(record, [...path, String(prop)])

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
          assertLiveTarget(record, path, target)

          const cloned = args.map(clone)

          if (target instanceof IdentifiedList) {
            for (const arg of cloned)
              if (isPlainObject(arg)) ensureItemId(arg)
          }

          const result = Array.prototype[prop].apply(target, cloned)

          if (boundary && samePath(path, boundary))
            localOp(record, path, prop, cloned, versionAt(record.versions, path))
          else if (boundary)
            replicateBoundary(record, boundary)
          else
            localSet(record, path, valueAtPath(record.target, path))

          return result === target ? receiver : result
        }

      if (!isContainer(rawOf(value)))
        return value

      let nextPath = [...path, String(prop)]
      const nextRaw = rawOf(value)

      if (target instanceof IdentifiedList && /^\d+$/.test(String(prop))) {
        const iid = nextRaw?.[ITEM_ID]

        if (iid)
          nextPath = [...path, iid]
      }

      const isStable = nextRaw instanceof IdentifiedList
      const nextBoundary = boundary ?? (
        !isStable && Array.isArray(nextRaw) ? nextPath : null
      )

      return proxify(nextRaw, record, nextPath, nextBoundary)
    },
    set(target, prop, value, receiver) {
      assertLiveTarget(record, path, target)

      const next = clone(value)

      if (target instanceof IdentifiedList &&
        /^\d+$/.test(String(prop)) && isPlainObject(next))
        ensureItemId(next)

      const changed = Reflect.set(target, prop, next, receiver)

      if (!changed)
        return false

      if (target instanceof IdentifiedList && !boundary)
        localSet(record, path, valueAtPath(record.target, path))
      else if (boundary)
        replicateBoundary(record, boundary)
      else
        localSet(record, [...path, String(prop)], next)

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

    replaceState(record, clone(state), [], true)

    return record.proxy
  }

  static sync(id) {
    const Ctor = this
    const live = liveFor(Ctor, id)

    if (live && rootFor(live)?.complete)
      return Promise.resolve(live)

    const store = storeFor(Ctor)
    const snapshot = buildCachedSnapshotGraph(Ctor, id, store.registry)

    if (snapshot) {
      const instance = applySnapshotMessage(snapshot, store.registry)

      if (instance)
        return Promise.resolve(instance)
    }

    return requestSnapshot(Ctor, id)
  }

  static use(bus) {
    const store = storeFor(this)

    for (const cleanup of store.cleanup)
      cleanup()

    store.cleanup = []

    if (store.registry.get(store.type) === this)
      store.registry.delete(store.type)

    store.bus = bus

    if (bus) {
      const registry = REGISTRIES.get(bus) ?? new Map()
      const current = registry.get(store.type)

      if (current && current !== this)
        throw new Error(`Reactive type "${store.type}" already registered`)

      REGISTRIES.set(bus, registry)
      registry.set(store.type, this)
      store.registry = registry
    } else {
      store.registry = new Map([[store.type, this]])
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

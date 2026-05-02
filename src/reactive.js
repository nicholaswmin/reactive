import {
  randomUUID,
  EVENTS,
  ARRAY_MUTATORS,
  SYNC_TIMEOUT_MS,
  STALE_REFERENCE_ERROR,
  REGISTRIES,
  ROOTS,
  PROXIES,
  TARGETS,
  rawOf,
  rootFor,
  isObject,
  isPlainObject,
  isContainer,
  storeFor,
  liveFor,
} from './internals.js'
import {
  IdentifiedList, ITEM_ID, assignItemId, ensureItemId,
} from './identity.js'
import {
  isIndexKey, pathKey, valueAtPath, setAtPath, deleteAtPath,
  resolveIdentifiedItemExists, samePath,
} from './path.js'
import {
  compareVersion, versionAt, newerAncestor, newerDescendant,
  rememberVersion, nextVersion, cloneVersions,
} from './version.js'
import { clone, serializeValue, versionsFrom } from './serialize.js'
import {
  storeSnapshot, buildSnapshotGraph, buildCachedSnapshotGraph,
  mergeSnapshotState,
} from './snapshot.js'

const assertLiveTarget = (record, path, target) => {
  if (!path.length)
    return

  if (rawOf(valueAtPath(record.target, path)) !== target)
    throw new Error(STALE_REFERENCE_ERROR)
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

      if (target instanceof IdentifiedList && isIndexKey(String(prop))) {
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
        isIndexKey(String(prop)) && isPlainObject(next))
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

const createRecord = (Ctor, id) => {
  const store = storeFor(Ctor)
  const target = Object.create(Ctor.prototype)
  const record = {
    authoritative: false,
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

  if (Array.isArray(value)) {
    const items = value.map(child => hydrate(child, registry))

    for (const item of items)
      if (isPlainObject(item) && '$iid' in item)
        delete item.$iid

    if (items.length && items.every(isPlainObject)) {
      const list = new IdentifiedList()

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const wire = value[i]?.$iid

        if (wire)
          assignItemId(item, wire)
        else
          ensureItemId(item)

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

const replaceState = (record, data, versions = []) => {
  for (const key of Object.keys(record.target))
    delete record.target[key]

  for (const [key, value] of Object.entries(data))
    record.target[key] = hydrate(value, record.store.registry)

  record.authoritative = true
  record.complete = true
  record.versions = versions instanceof Map
    ? cloneVersions(versions)
    : versionsFrom(versions)

  for (const version of record.versions.values()) {
    if (record.store.clock < version.tick)
      record.store.clock = version.tick
  }

  storeSnapshot(record)
}

const applySnapshotState = (record, data, versions) => {
  const remoteVersions = versions instanceof Map
    ? versions
    : versionsFrom(versions)

  const next = mergeSnapshotState(record, data, remoteVersions)

  replaceState(record, next.data, next.versions)
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
      pending.reject(
        pending.missingError ??
        new Error(`Timed out syncing ${store.type}:${id}`)
      )
  }, timeoutMs)

  store.pending.set(id, {
    missingError: null,
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

const requestRepair = record => {
  if (!record.store.bus)
    return

  record.authoritative = false
  storeSnapshot(record)
  requestSnapshot(record.Ctor, record.id).catch(() => {})
}

const canApplyRemote = (record, path, version) => {
  if (
    compareVersion(record.versions.get(pathKey(path)), version) >= 0 ||
    newerAncestor(record, path, version) ||
    newerDescendant(record, path, version)
  )
    return false

  if (!resolveIdentifiedItemExists(record.target, path)) {
    requestRepair(record)
    return false
  }

  return true
}

const applyRemoteSet = (record, path, value, version) => {
  if (!canApplyRemote(record, path, version))
    return false

  setAtPath(record.target, path, hydrate(value, record.store.registry))
  rememberVersion(record, path, version)
  storeSnapshot(record)

  return true
}

const applyRemoteDelete = (record, path, version) => {
  if (!canApplyRemote(record, path, version))
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
  const snapshot = liveRecord?.complete && liveRecord.authoritative
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

  if (message.missing) {
    pending.missingError = new Error(`Unknown ${store.type}:${message.id}`)
    return
  }

  clearPending(store, message.id)

  const instance = applySnapshotMessage(message, store.registry)

  if (!instance) {
    pending.reject(new Error(`Cannot hydrate ${store.type}:${message.id}`))
    return
  }

  pending.resolve(instance)
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

    replaceState(record, clone(state))

    return record.proxy
  }

  static sync(id) {
    const Ctor = this
    const live = liveFor(Ctor, id)
    const record = live ? rootFor(live) : null

    if (record?.complete && record.authoritative)
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
    const registry = bus
      ? REGISTRIES.get(bus) ?? new Map()
      : null
    const current = registry?.get(store.type)

    if (current && current !== this)
      throw new Error(`Reactive type "${store.type}" already registered`)

    for (const cleanup of store.cleanup)
      cleanup()

    store.cleanup = []

    if (store.registry.get(store.type) === this)
      store.registry.delete(store.type)

    store.bus = bus

    if (bus) {
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

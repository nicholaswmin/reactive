import {
  storeFor, typeId, graphKey, isObject, isPlainObject, SNAPSHOT_LIMIT,
} from './internals.js'
import { pathKey } from './path.js'
import {
  compareVersion, strongerVersion, setVersion,
  newestVersionInSubtree, cloneVersions,
} from './version.js'
import {
  cloneData, serializeRecordData, serializeVersions,
} from './serialize.js'

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

export {
  storeSnapshot,
  buildSnapshotGraph,
  buildCachedSnapshotGraph,
  mergeSnapshotState,
}

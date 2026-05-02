import {
  storeFor, graphKey, isObject, isPlainObject, SNAPSHOT_LIMIT,
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
  authoritative: record.authoritative,
  complete: record.complete,
  data: serializeRecordData(record),
  versions: cloneVersions(record.versions),
})

const storeSnapshot = record => {
  const { snapshots } = record.store

  snapshots.delete(record.id)
  snapshots.set(record.id, snapshotFor(record))

  while (snapshots.size > SNAPSHOT_LIMIT)
    snapshots.delete(snapshots.keys().next().value)
}

const snapshotMessageFor = (store, id, snapshot) => ({
  class: store.type,
  data: cloneData(snapshot.data),
  id,
  versions: serializeVersions(snapshot.versions),
})

const itemIdOf = item =>
  isPlainObject(item) && typeof item.$iid === 'string'
    ? item.$iid
    : null

const identified = value =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(item => itemIdOf(item))

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

  if (!rootSnapshot?.complete || !rootSnapshot.authoritative)
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

    const refStore = storeFor(RefCtor)
    const snapshot = refStore.snapshots.get(refId)

    if (!snapshot?.complete || !snapshot.authoritative)
      return false

    refs.push(snapshotMessageFor(refStore, refId, snapshot))

    return collectSnapshotRefs(snapshot.data, visit)
  }

  if (!collectSnapshotRefs(rootSnapshot.data, visit))
    return null

  return {
    ...snapshotMessageFor(store, id, rootSnapshot),
    refs,
  }
}

const buildSnapshotGraph = record => {
  if (!record.complete || !record.authoritative)
    return null

  const refs = []
  const seen = new Set([graphKey(record.store.type, record.id)])
  let valid = true

  const visit = current => {
    const type = current.store.type
    const key = graphKey(type, current.id)

    if (seen.has(key))
      return

    seen.add(key)

    if (!current.complete || !current.authoritative) {
      valid = false
      return
    }

    refs.push({
      class: type,
      data: serializeRecordData(current, visit),
      id: current.id,
      versions: serializeVersions(current.versions),
    })
  }

  const data = serializeRecordData(record, visit)

  if (!valid)
    return null

  return {
    class: record.store.type,
    data,
    id: record.id,
    refs,
    versions: serializeVersions(record.versions),
  }
}

const mergeIdentifiedList = (
  path,
  localValue,
  remoteValue,
  localVersions,
  remoteVersions,
  mergedVersions,
  localExact,
  remoteExact,
) => {
  const localItems = new Map(localValue.map(item => [itemIdOf(item), item]))
  const remoteItems = new Map(remoteValue.map(item => [itemIdOf(item), item]))
  const seen = new Set()
  const ids = []
  const add = item => {
    const id = itemIdOf(item)

    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }

  for (const item of compareVersion(localExact, remoteExact) > 0
    ? [...localValue, ...remoteValue]
    : [...remoteValue, ...localValue])
    add(item)

  return ids
    .map(id => mergeSnapshotValue(
      [...path, id],
      localItems.get(id),
      remoteItems.get(id),
      localVersions,
      remoteVersions,
      mergedVersions,
    ))
    .filter(value => value !== undefined)
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
    if (identified(localValue) && identified(remoteValue))
      return mergeIdentifiedList(
        path,
        localValue,
        remoteValue,
        localVersions,
        remoteVersions,
        mergedVersions,
        localExact,
        remoteExact,
      )

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

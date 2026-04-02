import { rawOf, rootFor, isReactive, isPlainObject, typeId } from './internals.js'
import { IdentifiedList, ITEM_ID, ensureItemId, assignItemId } from './identity.js'
import { pathKey, pathFrom } from './path.js'

const cloneData = value => {
  if (Array.isArray(value))
    return value.map(cloneData)

  if (isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneData(child)])
    )

  return value
}

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

export {
  cloneData,
  clone,
  serializeValue,
  serializeSnapshotValue,
  serializeRecordData,
  serializeVersions,
  versionsFrom,
}

import { rawOf, rootFor, isReactive, isPlainObject } from './internals.js'
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

const serializeValue = (value, wire = false, visit) => {
  if (isReactive(value)) {
    const root = rootFor(value)

    visit?.(root)

    return { $ref: root.store.type, id: root.id }
  }

  const raw = rawOf(value)

  if (Array.isArray(raw))
    return raw.map(child => serializeValue(child, wire, visit))

  if (isPlainObject(raw)) {
    const entries = Object.entries(raw)
      .map(([key, child]) => [key, serializeValue(child, wire, visit)])

    if ((wire || visit) && raw[ITEM_ID])
      entries.push(['$iid', raw[ITEM_ID]])

    return Object.fromEntries(entries)
  }

  return raw
}

const serializeRecordData = (record, visit = () => {}) =>
  Object.fromEntries(
    Object.entries(record.target)
      .map(([key, value]) => [key, serializeValue(value, false, visit)])
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
  serializeRecordData,
  serializeVersions,
  versionsFrom,
}

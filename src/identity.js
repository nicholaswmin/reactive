import { randomUUID } from './internals.js'

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

export { ITEM_ID, IdentifiedList, assignItemId, ensureItemId }

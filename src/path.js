import { SEP, rawOf, isContainer } from './internals.js'
import { IdentifiedList, ITEM_ID } from './identity.js'

const isIndexKey = segment => /^\d+$/.test(segment)

const pathKey = path => path.join(SEP)
const pathFrom = key => key ? key.split(SEP) : []
const samePath = (left, right) => pathKey(left) === pathKey(right)

const valueAtPath = (target, path) =>
  path.reduce((cursor, segment) => {
    const raw = rawOf(cursor)

    if (raw instanceof IdentifiedList && !isIndexKey(segment))
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

    if (raw instanceof IdentifiedList && !isIndexKey(segment)) {
      cursor = raw.find(el => el?.[ITEM_ID] === segment)

      if (!cursor)
        return

      continue
    }

    const next = path[index + 1]
    const current = rawOf(cursor[segment])

    if (!isContainer(current))
      cursor[segment] = isIndexKey(next) ? [] : {}

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

const resolvePathExists = (target, path) => {
  let cursor = target

  for (let i = 0; i < path.length - 1; i++) {
    const raw = rawOf(cursor)
    const segment = path[i]

    if (raw instanceof IdentifiedList && !isIndexKey(segment)) {
      cursor = raw.find(el => el?.[ITEM_ID] === segment)

      if (!cursor)
        return false
    } else {
      cursor = raw?.[segment]
    }
  }

  return true
}

export {
  isIndexKey,
  pathKey,
  pathFrom,
  samePath,
  valueAtPath,
  setAtPath,
  deleteAtPath,
  resolvePathExists,
}

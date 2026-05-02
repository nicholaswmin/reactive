import { SEP } from '#internals'
import { pathKey } from '#path'

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

const setVersion = (versions, path, version) => {
  const key = pathKey(path)
  const prefix = key ? `${key}${SEP}` : ''

  for (const existing of [...versions.keys()]) {
    if (existing === key || existing.startsWith(prefix))
      versions.delete(existing)
  }

  versions.set(key, version)
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

const rememberVersion = (record, path, version) => {
  setVersion(record.versions, path, version)

  if (record.store.clock < version.tick)
    record.store.clock = version.tick
}

const nextVersion = store => ({
  tick: ++store.clock,
  context: store.context,
})

export {
  compareVersion,
  strongerVersion,
  cloneVersions,
  setVersion,
  versionAt,
  newestVersionInSubtree,
  newerAncestor,
  newerDescendant,
  rememberVersion,
  nextVersion,
}

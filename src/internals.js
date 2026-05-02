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

const rawOf = value => TARGETS.get(value) ?? value
const rootFor = value => ROOTS.get(value)
const isReactive = value => ROOTS.has(value)

const isObject = value => value != null && typeof value === 'object'
const isPlainObject = value => isObject(value) && (
  Object.getPrototypeOf(value) === Object.prototype ||
  Object.getPrototypeOf(value) === null
)
const isContainer = value => Array.isArray(value) || isPlainObject(value)

const typeId = Ctor => {
  const value = Ctor.type ?? Ctor.name

  if (typeof value !== 'string' || value === '')
    throw new Error('Reactive type must be a non-empty string')

  return value
}

const graphKey = (type, id) => `${type}:${id}`

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
    snapshots: new Map(),
    type,
  }

  store.finalizer = new FinalizationRegistry(({ id, refs }) =>
    refs.delete(id)
  )

  STORES.set(Ctor, store)

  return store
}

const liveFor = (Ctor, id) => {
  const store = storeFor(Ctor)
  const ref = store.refs.get(id)
  const value = ref?.deref()

  if (!value)
    store.refs.delete(id)

  return value
}

export {
  randomUUID,
  EVENTS,
  ARRAY_MUTATORS,
  SNAPSHOT_LIMIT,
  SYNC_TIMEOUT_MS,
  STALE_REFERENCE_ERROR,
  REGISTRIES,
  ROOTS,
  PROXIES,
  TARGETS,
  SEP,
  rawOf,
  rootFor,
  isReactive,
  isObject,
  isPlainObject,
  isContainer,
  graphKey,
  storeFor,
  liveFor,
}

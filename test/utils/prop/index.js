import { AssertionError } from 'node:assert'
import { assert } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

const snapshot = value => JSON.parse(JSON.stringify(value))

const details = info =>
  Object.entries(info)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ')

const models = (actual, expected, info = {}) => {
  const actualSnapshot = snapshot(actual)

  if (isDeepStrictEqual(actualSnapshot, expected))
    return

  throw new AssertionError({
    actual: actualSnapshot,
    expected,
    message: `models failed: ${details(info)}`,
    operator: 'deepStrictEqual',
  })
}

export class Generator {
  #next

  static WORDS = [
    'alpha',
    'berlin',
    'delta',
    'lima',
    'oslo',
    'tokyo',
  ]

  static Assertions() {
    assert.register('models', models)
  }

  static #rng(seed) {
    let value = seed >>> 0

    return () => {
      value = (value + 0x6D2B79F5) | 0

      let next = Math.imul(value ^ (value >>> 15), 1 | value)

      next ^= next + Math.imul(next ^ (next >>> 7), 61 | next)

      return ((next ^ (next >>> 14)) >>> 0) / 4294967296
    }
  }

  constructor(seed) {
    this.#next = Generator.#rng(seed)
    this.words = this.word()
    this.zips = this.zip()
    this.names = this.name()
    this.tags = this.tags()
  }

  bool() {
    return this.#next() < 0.5
  }

  int(max) {
    return Math.floor(this.#next() * max)
  }

  pick(items) {
    return items[this.int(items.length)]
  }

  *name() {
    while (true)
      yield `${this.words.next().value}-${this.int(1000)}`
  }

  *tags() {
    while (true)
      yield Array.from(
        { length: 1 + this.int(4) },
        () => this.words.next().value
      )
  }

  *word() {
    while (true)
      yield this.pick(this.constructor.WORDS)
  }

  *zip() {
    while (true)
      yield String(this.int(100000)).padStart(5, '0')
  }
}

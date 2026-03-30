const PEERS = new WeakMap()

class Bus {
  #handlers = new Map()
  #delay
  #jitter
  #loss
  #dropping = false
  sent = []

  constructor({ delay = 0, jitter = 0, loss = 0 } = {}) {
    this.#delay = delay
    this.#jitter = jitter
    this.#loss = loss
  }

  static createPair(opts = {}) {
    const a = new Bus(opts)
    const b = new Bus(opts)

    PEERS.set(a, b)
    PEERS.set(b, a)

    return { a, b }
  }

  static flush() {
    return new Promise(resolve => setTimeout(resolve, 0))
  }

  send(event, payload) {
    this.sent.push({ event, payload })

    const peer = PEERS.get(this)
    if (!peer) return

    if (this.#dropping) return

    if (this.#loss && Math.random() < this.#loss)
      return

    const ms = Math.max(0,
      this.#delay + (Math.random() * 2 - 1) * this.#jitter)

    const run = () => peer.receive(event, payload)

    ms ? setTimeout(run, ms) : queueMicrotask(run)
  }

  drop() { this.#dropping = true }
  pass() { this.#dropping = false }

  on(event, handler) {
    const listeners = this.#handlers.get(event) ?? new Set()

    listeners.add(handler)
    this.#handlers.set(event, listeners)

    return () => listeners.delete(handler)
  }

  receive(event, payload) {
    for (const handler of this.#handlers.get(event) ?? [])
      handler(payload)
  }
}

export { Bus }

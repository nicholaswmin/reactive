import { Reactive } from '../../../src/index.js'
import { Bus } from '../bus/index.js'

export const createContext = () => {
  class User extends Reactive {}
  class Post extends Reactive {}

  return { Reactive, User, Post }
}

export const createLinkedContexts = () => {
  const a = createContext()
  const b = createContext()
  const bus = Bus.createPair()

  a.User.use(bus.a)
  a.Post.use(bus.a)
  b.User.use(bus.b)
  b.Post.use(bus.b)

  return { a, b, bus }
}

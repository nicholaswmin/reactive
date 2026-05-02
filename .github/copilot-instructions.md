Follow [`AGENTS.md`](../AGENTS.md) for repository conventions
and [`docs/spec.md`](../docs/spec.md) for the implementation spec.

When reviewing pull requests:

- flag:
  - changes that violate identity, mutation, sync, arrays, or
    refs guarantees described in those files
  - protocol changes lacking the test matrix in `docs/spec.md`
    (local, one-way, both-way, stale, snapshot repair, arrays)
- skip:
  - missing comments — minimal by design
  - `Reactive` proxies, private fields, `t.assert.*` strict
    assertions — project idioms

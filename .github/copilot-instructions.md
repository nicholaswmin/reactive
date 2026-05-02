Follow [`AGENTS.md`](../AGENTS.md) for repository conventions and the
runtime contract.

When reviewing pull requests:

- flag:
  - changes that violate identity, mutation, sync, arrays, or
    refs guarantees described there
  - protocol changes lacking the test matrix in `AGENTS.md`
    (local, one-way, both-way, stale, snapshot repair, arrays)
- skip:
  - missing comments — minimal by design
  - `Reactive` proxies, private fields, `t.assert.*` strict
    assertions — project idioms

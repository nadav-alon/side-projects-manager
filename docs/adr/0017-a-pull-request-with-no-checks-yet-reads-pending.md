---
status: accepted
---

# A pull request with no checks yet reads pending

Supersedes the "no checks reads green" clause of ADR 0011 and ADR 0016. `checksStatusFrom` read an
empty checks rollup as green, so a head whose CI had not yet created its check runs passed the merge
gate and the ready-mark. Every managed repo runs CI on pull requests, so an empty rollup means "not
started yet". Decided on #1857, built on #1892, under #1245.

## What changed

An empty checks rollup reads `none`, a fourth status the port answers in one read, always pending in
every way but its name: the merge gate and the ready-mark wait on it and sweep it as they do
`pending`.

- Still empty after the 3-minute `settledChecks` wait, the pull request goes to the existing pending
  sweep like any other pending one.
- After `PENDING_MERGE_LIMIT` a pending merge, or the pending ready beside it, is left for the
  developer with the reason "no checks ran on <sha>", where checks that are running read "checks
  still running after a day".

## Consequences

A project with no CI never turbo-merges until the developer adds one. `new-project` is unchanged.

*Amended by #1934:* `new-project` now scaffolds a `ci.yml` into a repo it creates, or into a checkout
with no workflows of its own, so a new project has checks from its first pull request. A repo that
already has workflows under any name is left as it is.

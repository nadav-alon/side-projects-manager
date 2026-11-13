---
status: accepted
---

# A pull request is marked ready for review only on green checks

Extends ADR 0009's reading of checks and ADR 0015's sweep. Until now the manager marked a pull
request ready for review without reading its checks, both when an apply-review ticket finished and on
a clean review, and four pull requests went out ready with red CI. Decided on #1245, built on #1785.

## What changed

Both paths read the checks through `settledChecks` before marking the pull request ready for review,
as the merge gate does: polling for up to 3 minutes, no checks at all reading green.

- **Green** marks it ready for review, as before.
- **Failing** leaves it a draft, unmarked. What a red pull request gets beyond that is #1788's.
- **Still running after the wait** leaves it a draft and records it in `state.json` —
  `{pullRequest, deferredAt}`, keyed by the pull request since a clean review's ticket and an
  apply-review ticket both have one — for a **pending-ready sweep**.

The ticket closes and the pull request is labelled whatever the checks said: the work is done.

The pending-ready sweep runs at each turn of the loop and at the start of the next invocation, just
ahead of ADR 0015's, and reads the checks once, with no wait. A record made this invocation is not
read straight away.

- **Green** marks it ready for review.
- **Still running** stays pending.
- **Running for 24 hours** is left for the developer: dropped, still a draft.
- **Failing** is dropped, still a draft.
- **Closed, merged, or marked ready by hand** settles quietly.

The summary names the held pull request as "left draft: checks still running; a later run marks it
ready for review once green", and the sweep's outcome under "Ready for review settled", a pull
request left for the developer as "left for you: checks still running after a day".

## Turbo

A turboable pull request held on running checks still has its merge recorded pending
(ADR 0015): the gate is asked for its consent only and never attempts the merge on a draft. The
merge sweep leaves a pull request with a pending ready alone until the ready sweep has settled it,
so the pull request is marked ready first and merged on the same or a later turn once green. A
pull request held on failing checks gets no gate at all, so no `ready-for-human` label.

## Known gaps

- A turboable pull request whose ready-mark is held on failing checks is neither merged nor labelled;
  #1788 decides what a red pull request gets.

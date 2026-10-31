---
status: accepted
---

# A merge pending on checks is read again on a later sweep

Amends ADR 0009's wait on pending checks. That ADR waits out pending checks inside the gate for at
most 3 minutes, then labels the pull request `ready-for-human`, and decided against re-checking on a
later sweep. On a project whose CI outlasts those 3 minutes, a turboable pull request therefore
never merged. Decided on #1439.

## What changed

A pull request whose checks still read `pending` when the 3 minutes end is no longer labelled. The
gate records the merge as **pending** in `state.json` — `{repo, number, pullRequest, deferredAt}`,
`number` being the implementation ticket — and the grant record is used up as before. The consent
check has already passed; it is not asked again.

A **pending-merge sweep** reads the checks again, once, with no wait, at each turn of the loop and
at the start of the next invocation:

- **Green and mergeable** merges, as the gate would have.
- **Still pending** stays pending. A merge recorded this invocation is not read straight away: the
  gate has just waited on those checks.
- **Failing, a refused merge, or an unreadable pull request** is labelled `ready-for-human`, as the
  gate would have.
- **Pending for 24 hours** is labelled `ready-for-human` too, so a check that never reports does not
  hold the pull request for ever.
- **A pull request put back to draft** withdraws the developer's consent: dropped without merging or
  labelling, and named under "Merges settled".
- **A pull request closed or merged by hand**, or whose implementation ticket is no longer open,
  settles quietly: not merged, not labelled.

The summary of the invocation that settles a merge names the outcome under "Merges settled", and the
invocation that deferred it says "Not merged yet".

## Known gaps

- The sweep runs at the top of a loop turn. When the apply-review was the last work, the loop ends
  with the merge still pending and the next invocation reads it, so the merge can lag by one
  invocation interval.
- A developer who removes `turboable` after the deferral does not stop the merge: the implementation
  ticket was handed back, and its grant labels stripped, before the merge was deferred, so there is no
  label left to re-read. Putting the pull request back to draft is the withdrawal.

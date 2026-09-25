---
status: accepted
---

# The manager merges a turboable ticket's pull request

The manager has never merged a pull request: it opens one, promotes it once its apply-review ticket
finishes, and leaves the merge itself to the developer. An implementation ticket may now carry
`turboable`, a label a human sets, that lets the manager finish the loop itself: once such a
ticket's apply-review ticket finishes, the manager merges its pull request if it is mergeable, green
and free of declined threads, and otherwise leaves it for the developer. Decided in triage on #325.

## Why it went this way

**Per ticket, not per project.** Turbo (ADR 0006) already lets a project stand consent to apply a
review, and to rebase, without being asked each time. Merging is a bigger step than either — it is
the one nothing can undo by commenting again — so it gets its own, narrower consent: a ticket's own
`turboable` label, set by a human at triage, rather than a blanket setting a whole project inherits.
A turbo project with no turboable tickets keeps behaving exactly as it does today.

**Enforced against the label's timeline, not its current state.** Agent runs and the manager post
with the same GitHub identity as the developer — the same identity problem ADR 0006 notes for the
reviewer — so nothing about a `turboable` label on a ticket says a human set it rather than a run.
Checking the label's own timeline event — labeled before that ticket's implementation run started,
not merely present now — stops a run granting its own ticket consent mid-run: a label it adds to
itself lands after that run's own start, which reads as not in time. It does nothing for a ticket
that starts out carrying the label, which is what stripping is for: the manager strips `turboable`
from every ticket it opens, so a discovery can never be born with it. Each covers what the other
cannot — the timeline check a self-grant mid-run, stripping a label present from birth.

**One pass, bounded the same way apply-review and rebase already are.** "Merge once finished" could
otherwise cycle indefinitely through rebase and apply-review chasing a moving mergeable state. Only
the single apply-review run already in the loop is trusted: the manager checks once, right after it,
merges if the pull request is mergeable, green and has no declined threads, and otherwise labels it
`ready-for-human` and stops. No retry, and no `/rebase` posted on its behalf — unlike a hand back,
which never labels a pull request, only its ticket.

**Merge commit, and the branch deleted with it.** Merge commit because that is how the developer
already merges a pull request by hand; nothing about turboable should read differently in the repo's
history than a merge the developer made themselves. The branch is deleted after, the same tidy-up a
manual merge gets on the repo host.

**Stacked pull requests stay out of scope.** A turboable base merging would retarget or break any
pull request stacked on it, and #32 has not yet specced what a stack even is to this manager. Until
it is, turboable assumes every pull request stands alone.

## What it looks like

- **`turboable`**, a label on an implementation ticket, set by a human. Absent means the manager
  never merges that ticket's pull request, whatever turbo says.
- **Timeline-checked**, against the label's timeline: on before the ticket's own implementation run
  started, not merely present now.
- **Stripped**: the manager never opens a ticket carrying it.
- **Fires once**, right after the one apply-review run a turboable ticket's pull request already
  gets: merge — mergeable, green, no declined threads — or `ready-for-human` on the pull request and
  stop. No retry, no re-rebase.
- **Merge commit, branch deleted after.** The only merge method the manager uses.
- **Stacked pull requests**: out of scope until #32 specs them.

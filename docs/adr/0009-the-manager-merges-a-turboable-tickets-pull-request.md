---
status: accepted
---

# The manager merges a turboable ticket's pull request

The manager has never merged a pull request: it opens one, promotes it once its apply-review ticket
finishes, and leaves the merge itself to the developer. An implementation ticket may now carry
`turboable`, a label a human sets, that lets the manager finish the loop itself: once such a
ticket's apply-review ticket finishes, or its review comes back clean — CONTEXT.md's "Clean
review" — with no apply-review ticket ever opened, the manager merges its pull request if it is
mergeable and green, and otherwise leaves it for the developer. Decided in triage on #325; extended
to a clean review's own finish on #936, so a turboable ticket whose review needs nothing applied
still reaches the gate.

A declined thread was briefly a third condition, alongside mergeable and green. It entered #325 as
an unconfirmed triage assumption, never actually asked for — ultra turbo was specced as "merges the
branch afterwards", nothing more — and #1058 dropped it: the gate does not ask about declined
threads at all.

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
from every ticket it opens, so a discovery can never be born with it. Neither covers a run on one
ticket labeling a *different*, not-yet-run ticket `turboable` — posting with the developer's own
identity, so the label still predates that ticket's own run, and the manager did not open that ticket
itself, so stripping never touches it. A third check closes that gap: the granting event must also
fall inside no run span, of any ticket, in the same repo (see CONTEXT.md's "Run span"); a run's own
span covers it from the moment that run starts, so a label it grants any ticket in the project,
including its own, reads as not in time. Known gaps: recording a span is best-effort, so a run whose
write failed leaves no span for this check to see; a ticket run more than once keeps only its
latest run's span, so an earlier run's own grant is no longer covered once that ticket runs again;
and a span a crash left open reads as ended at its own start rather than covering everything after
it, so a grant that crashed run itself made between its own start and its death now falls outside
its own span too, and counts as consent.

**One pass, bounded the same way apply-review and rebase already are.** "Merge once finished" could
otherwise cycle indefinitely through rebase and apply-review chasing a moving mergeable state. Only
the single apply-review run already in the loop is trusted — or, when the review needed nothing
applied, the single review run itself: the manager checks once, waiting out pending checks, right
after whichever of the two just finished the ticket, merges if the pull request is mergeable and
green, and otherwise labels it `ready-for-human` and stops. A run that has just pushed commits
usually meets checks still `pending`, so a pending read is waited out inside the gate — the run
stays open — for at most 3 minutes from that first pending read: green merges, failing or still
pending after 3 minutes is `ready-for-human`. Re-checking on a later sweep was decided against. No
retry beyond that wait, and no `/rebase` posted on its behalf — unlike a hand back, which never
labels a pull request, only its ticket. A review with findings never reaches the gate
this way: turbo posts `/apply-review` instead, exactly as it always has, and the gate fires only once
that ticket later finishes — never both, since a review is either clean or is not.

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
- **Run-span-checked**: the granting event must also fall inside no run span, of any ticket, in the
  same repo — closes the gap a run labeling a *different*, not-yet-run ticket leaves in the other two.
  Known gaps: a failed span write leaves no span to check; a ticket's later run replaces its
  earlier run's span; and a span a crash left open reads as ended at its own start, so a grant that
  crashed run itself made before its death now falls outside its own span too.
- **Fires once**, with a bounded wait on pending checks, right after the one apply-review run a
  turboable ticket's pull request already gets, or, when its review comes back clean, right after
  that review's own run instead: merge — mergeable and green — or `ready-for-human` on the pull
  request and stop. Checks reading `pending` are re-read inside the gate for at most 3 minutes from
  the first pending read; the rest is unchanged. No retry beyond that, no re-rebase. A review with
  findings never fires it directly: it reaches the gate only once its own apply-review ticket later
  finishes.
- **Merge commit, branch deleted after.** The only merge method the manager uses.
- **Stacked pull requests**: out of scope until #32 specs them.

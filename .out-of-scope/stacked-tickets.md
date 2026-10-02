# Working a ticket on top of an unmerged draft

A ticket blocked by another waits for that blocker to merge. No agent builds on a blocker whose work
is still an open draft pull request, and the loop does not stack pull requests on one another.

## Why this is out of scope

The wait this was meant to remove is mostly gone. The loop fires every 15 minutes, and the manager
merges a turboable ticket's pull request itself (ADR 0009), so a chain of turboable tickets advances
link by link without the developer. A chain that should move unattended gets labelled `turboable`.

Stacking would bring back what turbo avoids: rebasing every later link when an earlier one changes in
review, and reviewing a diff whose base is still moving. The git-spice research reached the same
conclusion and recommended against adopting it.

That changes if chains that can't be turboable (ones the developer must review link by link) become
the common case and their wait dominates throughput.

## Prior requests

- #32: work a ticket whose blocker is still an open draft PR

---
status: accepted
---

# The manager owns its container adapter

The spec said agent runs are delegated to sandcastle. They are not: the sandbox port is backed by
`containerSandbox`, which clones the project checkout into a throwaway workspace, runs the image
from #6 against it with `docker run`, and fetches back any branch that gained commits. This records
that as the decision it is, because nothing else in the repo does — it arrived as an implementation
detail of #7 rather than as a choice anyone made. The adapter itself lands with #28; this ADR is
written against its shape, and needs revisiting if that shape changes in review.

## Why it went this way

The specced shape — a coding agent in a container on a *worktree* — does not survive contact with a
bind mount. A worktree's `.git` is a file holding an absolute path back into the parent repo, so a
mounted worktree gives the container a `.git` pointing at a path that does not exist there: every
git command the agent runs fails, it can never commit, and the run still reports success with zero
commits. A clone carries its objects with it and needs nothing else mounted, so the adapter clones.

Having written the clone, the branch and the fetch-back, what was left for a third-party runner to
do was `docker run` — and the manager already owned the image it would have run.

## What this costs

Isolation is now exactly what the adapter's flags give and no more: one bind mount, `--rm`,
credentials passed by name rather than value. There is no network restriction and no resource
ceiling, and the container is root until #27. The spec's claim that the blast radius of an
unattended run is one project's worktree is backed by this adapter's own choices, not by a sandbox
someone else maintains — which means it is ours to keep true.

## Reversing it

`containerSandbox` takes its container as a parameter (`container: Container = dockerContainer`),
which exists so the git half can be tested without docker but also bounds this decision: swapping
in a different runner is one function, not a rewrite. Whether sandcastle is worth that swap was
never actually evaluated — #29 is the research that answers it, and this ADR should be revisited
when it lands.

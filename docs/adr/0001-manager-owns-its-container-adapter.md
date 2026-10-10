---
status: accepted
---

# The manager owns its container adapter

The spec said agent runs are delegated to sandcastle. They are not: the sandbox port is backed by
`containerSandbox`, which makes a throwaway clone of the project checkout, runs the image
from #6 against it with `docker run`, and fetches back any branch that gained commits. This records
that as the decision it is, because nothing else in the repo does — it arrived as an implementation
detail of #7 rather than as a choice anyone made.

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
credentials passed by name rather than value, and the container pinned to the invoking developer's
own uid. There is no network restriction and no resource ceiling. The spec's claim that the blast
radius of an unattended run is one throwaway clone of one project is backed by this adapter's own
choices, not by a sandbox someone else maintains — which means it is ours to keep true.

The agent CLI's own sandbox is switched off for every run (`--settings`), whatever a project's
`.claude/settings.json` demands: the container is the boundary, and the image carries no bubblewrap
to give the CLI one.

A rebase run is the one run kind whose contract is to force-push, and a project's
`.claude/settings.json` may deny that: `--permission-mode bypassPermissions` does not override a
deny rule, and a deny outranks every allow, so `--settings` alone cannot lift it. The manager
outranks the project here too, the second setting it does: a rebase run is started with
`--setting-sources user`, so the project's settings are not read for it. Every other run kind reads
the project's settings as before, force-push denies included.

The same `--settings` carries the manager's own deny rules for `gh pr merge`, a push to the base
branch and a force-push, on every run. They protect those operations whatever the project's own
`.claude/settings.json` denies: a project that wrote none is protected the same. Deny rules merge
across settings sources, so a project's own rules still apply on top of these in every run that
reads them; a rebase run, which does not, can be let past the project's force-push rule only because
the manager carries its own, lifted to `--force-with-lease` for the kinds whose contract is to
force-push (apply-review, rebase). They live in `--settings` rather than the image because the
settings travel with the manager's code, differ by run kind and base branch, and change with a
commit rather than an image rebuild. A run refused a command matching one says so in its output, so
a developer can see the manager's rule among whatever else denied it.

What a rebase run gives up by not reading project settings is everything else the project's file
carries: its other `permissions.deny` rules, its hooks and its `env`, and possibly its `CLAUDE.md`
and `.claude/skills` too, if the CLI gates them on the project source as the Agent SDK does (not
checked against the real CLI). The manager accepts that cost because a deny it cannot lift would
otherwise stop the run's whole contract.

The user pin is not a privilege boundary and was never chosen as one: the agent runs as the
developer, which is whose files the bind mount exposes anyway. What it buys is that the clone comes
back owned by the developer, and that the CLI will run unattended at all — it refuses
`bypassPermissions` under uid 0.

## Reversing it

`containerSandbox` takes its container as a parameter (`container: Container = dockerContainer`),
which exists so the git half can be tested without docker but also bounds this decision: swapping
in a different runner is one function, not a rewrite. Whether sandcastle is worth that swap was
never actually evaluated — #29 is the research that answers it.

It answers: don't swap. Sandcastle solves the dot-git-pointer problem this ADR describes above, more
cleanly than a clone, but it has no equivalent of a spend ceiling at all, and throws away a failed
run's commits, output and spent tokens by default — the two failures next to it in "what this costs"
that a swap would need to fix rather than inherit. Full findings, each against a primary source, are
in [`docs/research/sandcastle.md`](../research/sandcastle.md), including what would have to change
for the recommendation to flip. This decision stands as accepted until that changes.

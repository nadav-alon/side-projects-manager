---
status: accepted
---

# A turbo project merges its own uniform sync pull request

The uniform sync sweep (CONTEXT.md's "Uniform sync sweep") proposes bringing a drifted project's
uniform files back in step as a pull request, and until now left the merge to the developer — a
click per project every time a convention changed, on a change that is by construction a copy of the
manager's own files. A project registered turbo now has the manager merge that pull request itself,
in the same sweep. Decided on #1035.

## Why it went this way

**Consent is the project's `turbo`, not a per-ticket label.** ADR 0009 asks a human for a
`turboable` label on each ticket because a ticket's pull request carries arbitrary agent work. A
sync pull request carries none: it has no ticket, and what it may contain is fully checkable. So
the standing consent turbo already gives a project (ADR 0006, ADR 0007) is enough. A project with
turbo off keeps its sync pull request open for the developer, exactly as before, and the manager's
own repo stays out of the sweep.

**Recognised by branch and by bytes.** The head branch is `uniform-sync`, and the diff touches
nothing but `UNIFORM_FILES`, each file byte for byte the manager's copy at merge time. The bytes
are read back from the pull request's head, not remembered from the push, so an edit made on the
branch since cannot ride along.

**A moved master is not a failure.** When a file matches an earlier version of the manager's copy
rather than the current one, the manager's master moved after the pull request was made. The pull
request is left open for the next sweep, which proposes again from the new master. Any other
difference — a file outside `UNIFORM_FILES`, a deletion, bytes the manager never held — is somebody
else's work on the branch, and is labelled `ready-for-human`.

**Green means what ADR 0009's gate means.** Checks are waited out for at most 3 minutes after the
first pending read; a project with no checks counts as green. A pull request still not green after
that, or that the host refuses to merge, is labelled `ready-for-human` and the sweep stops.

**A labelled sync pull request is left alone.** Later sweeps push nothing to it and merge nothing,
and name it in the summary each run until the developer has dealt with it.

**Merge commit, branch deleted after**, as ADR 0009.

## What it looks like

- **Consent**: `turbo` on the project in `registry.json`.
- **Recognition**: head branch `uniform-sync`, diff only `UNIFORM_FILES`, each equal to the
  manager's copy now.
- **Fires** right after the sweep proposes, in the same sweep.
- **Not green or refused**: `ready-for-human` on the pull request, sweep stops.
- **Earlier version of a file**: left for the next sweep to propose again.
- **Anything else different**: `ready-for-human`.
- **Already `ready-for-human`**: untouched, named in the summary each run.

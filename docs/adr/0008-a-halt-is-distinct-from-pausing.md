---
status: proposed
---

# A halt is distinct from pausing, kept in its own file

The README's only advice for stopping the mornings has been "to halt the mornings, pause the
projects" — pausing every registered project by hand in `registry.json`, one at a time, or editing
the crontab directly. Neither is really a halt: pausing every project is developer intent about
each project, read again the moment any one of them is unpaused, and a crontab edit is silently
undone the next time `scripts/install-triggers.sh` runs. The loop now has an actual halt: `halt`
engages it, `resume` clears it, and every firing while it is engaged does nothing but say so. This
is the implementer's own answer to #765's "grill before ready" open question, not yet grilled —
`status: proposed` until a developer confirms it.

## Why it went this way

**A halt is not the registry's business.** The registry is the hand-edited document of intent per
project — which exist, which are paused, which are turbo. A halt says nothing about any project; it
says the loop itself should not run right now, on this machine, whatever the registry lists. Folding
it into `registry.json` would make "pause every project" and "halt" the same edit again, which is
the confusion #765 was opened to resolve.

**Nor the state document's.** `state.json` is machine-written, and rewritten wholesale
each invocation — it is what the loop has done, not what a developer is asking it not to do. A halt
belongs beside the invocation lease instead: a file under the manager home that answers one question
by its own presence, gitignored like `invocation.lease` and `trigger.log`, so engaging or clearing it
is a filesystem write with nothing to commit or push.

**Checked ahead of the lease, not inside the loop.** `morningLoop` stays a pure function of its
ports, same as the lease already keeps it — the halt is a trigger-level concern, asked by
`src/bin/morning-run.ts` before it ever calls `invokeExclusively`. A halted firing therefore takes no
lease, opens no journal record, and writes nothing to `state.json`: it claims no day, so the loop
picks up exactly where it left off once resumed.

## What it looks like

- **`halt` and `resume`**, two commands, each idempotent and printing what it did — including doing
  nothing, when the halt already stood as asked.
- **One file under the manager home**, `halt`, whose contents are never read — only its presence
  matters. Untouched by `scripts/install-triggers.sh`, which only ever edits the crontab and shell rc
  files, so a halt survives it being re-run, and survives a reboot the same way `registry.json` does.
- **`status` names it** first, ahead of the trigger and budget lines, when engaged — silent when not,
  the same restraint the other callout lines already use.

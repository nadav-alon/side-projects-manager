---
status: accepted
---

# The loop notices conflicts it did not cause

Pull requests cut from the same base branch all open clean. The first to merge moves the base, and
every sibling touching the same code is conflicting from then on. Until now nothing noticed: a
pull request sat conflicting until the developer opened it and typed `/rebase`. The loop now runs a
conflict sweep before every selection: it labels conflicting pull requests `needs-rebase` in every
project, unlabels clean ones, and in a turbo project also posts `/rebase`. Decided while grilling
#527.

## Why it went this way

**Noticing and acting take different consent.** A label costs nothing and says only what the repo
host already knows, so every project gets it. A rebase ticket spends agent time, and spending it
unasked is what turbo consents to (ADR 0006) — so only a turbo project gets `/rebase` posted. The
manager posts the literal comment for the reason ADR 0006 gives: the workflow that turns it into a
ticket is a uniform file, and a second implementation in the manager would drift from it.

**The loop, not a workflow on push to the base branch.** A workflow would fire the moment a merge
lands, but it would be a uniform file, which may not name the manager, and so could never read
turbo, which lives in the manager's registry. Nor would it see the other way a pull request
becomes clean — a developer rebasing by hand pushes to the pull request's branch, not the base —
so the label would never come off. The loop already holds the repo host, the registry and turbo.
What is given up is promptness: a merge is noticed at the next selection, not the moment it lands.
The sweep runs before every selection, not once per invocation, because one invocation can run for
hours, holding the lease that keeps every other firing out.

**One read, never retried.** GitHub computes mergeability lazily. A rebase ticket retries its read
until it settles, because acting on an unsettled answer there would close a ticket on a branch that
still conflicts. The sweep does not: retrying every pull request before every selection would stall
selection, and an unsettled pull request is simply left for the next sweep, whose read the first
one set GitHub computing.

**No cap on rebase tickets.** One merge can conflict five siblings, and rebase tickets are selected
before every other kind, so five would preempt all other work. That is accepted: each sibling
rebases onto the base branch, not onto the others, so working them one at a time buys nothing, and
the budget gate already charges each run.

## What it looks like

- **Which pull requests**: open ones, draft or ready, whose body names the ticket they close — the
  same ones `/rebase` accepts, so the sweep never posts a comment the workflow would refuse. Ready
  ones matter most: they are the next to merge.
- **Paused projects** are skipped entirely, as selection skips them.
- **`/rebase` once per pull request**: posted only while no open issue carries that pull request's
  rebase-ticket line, whatever its labels, so a rebase ticket handed back to the developer stops the
  sweep from asking again.
- **The label comes off whenever the pull request reads clean**, rebase ticket open or not: the
  label means not mergeable now, and a ticket still open finds nothing to rebase and closes itself.
- **Best effort**, like the `reviewed` label and the turbo `/apply-review`: a refused read, label
  or comment never blocks selection or fails the invocation, and the summary reports each label,
  unlabel and refusal once per invocation, however many sweeps met it — but each `/rebase` post on
  its own, since #710 lets a pull request whose earlier rebase ticket has closed be posted on
  again in the same invocation, and each post is a distinct ticket the developer needs named.

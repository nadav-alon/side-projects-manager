---
status: amended by ADR-0010
---

# The gate charges a run estimate before a run starts

The gate used to compare only what a window had already consumed against what it may spend, so a
run authorised at the boundary spent its whole spend ceiling out of the reserve, and runs in
progress overshot by one spend ceiling each (ADR 0003). It now charges a run estimate, in tokens,
for the run about to start and for every run still in progress, and a run starts only if the
reserve would survive. The estimate comes from the ticket's size label, `size:S` to `size:XL`, whose
token values the budget document sets. Decided while grilling #38; supersedes ADR 0003.

## Why it went this way

ADR 0003 turned down counting runs in progress because nothing can see what a live run is spending.
A declared estimate does not need to see it, so that objection falls away. The spend ceiling still
binds each run, in dollars; the estimate is what the gate reasons in, in tokens, and the two are
allowed to disagree rather than tied together by a price per token the manager cannot check.

## Considered options

- **Projecting from history** (the largest of the last few runs). Turned down: the first run on a
  fresh machine has nothing to project from, and recorded costs are heavy-tailed — one 8.45M run
  among runs mostly under 210k — so any simple rule is ruled by its outliers.
- **Deriving the estimate from the spend ceiling** through a stated token price. Turned down: the
  price moves and differs by model, and keeping it honest is the same ranking of models ADR 0002
  refused.
- **A token count per ticket** (`cost:2000000`) or a line in the issue body. Turned down for sizes:
  four labels stay readable when scanning a backlog, and a body line drifts from whatever format the
  loop parses.
- **Weighting the estimate by model.** Turned down: the provider publishes no per-model quota
  weights. A ticket expected to run on a costlier model is sized larger instead.

## What this costs

An estimate set high stands the loop down with room to spare, and the stand-down says it was the
estimate rather than a spent window, so the developer can tell which. An estimate set low is the old
overshoot again. Nothing corrects the figures automatically: the summary sets each run's cost beside
its estimate and flags a run that spent more.

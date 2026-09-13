---
status: superseded by ADR-0004
---

# The gate accepts overshoot from runs in progress

The container sandbox used to serialize every run and review in the process, and gave the budget
gate as the reason: a review budgeted while an implementation was still spending would make the
gate's accounting a race. Runs and reviews now overlap, on one checkout or several, and the gate
still does not count the ones in progress. Decided while grilling #117.

## Why it went this way

Counting runs in progress means the gate projecting what a run still under way will spend, which
nothing out here can see until its container exits. That was judged not worth the complexity and
the bugs it would bring. Serializing runs kept the accounting honest only by costing wall-clock time
on every morning with more than one ticket.

## What this costs

Every run in progress when the gate says go can still spend up to its spend ceiling, so a morning can
overshoot what the gate projected by as many spend ceilings as there are runs in progress. The
concurrency limit (#119) bounds how many that is, and its default of 1 keeps the old behaviour.

## Reversing it

Setting the concurrency limit to 1 removes the overshoot without undoing the sandbox change. Counting
runs in progress in the gate is the other way back, and would need the projection this turned down.

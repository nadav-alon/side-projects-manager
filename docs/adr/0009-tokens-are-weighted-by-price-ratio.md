---
status: accepted
---

# Tokens are weighted by price ratio, not summed at equal weight

The gate, the ledger, and a run's own recorded spend all summed `input + output + cache_creation +
cache_read` at equal weight. A run's tokens are mostly cache reads, which the provider prices far
below a fresh input token, so the recorded figure tracked how much of the conversation was resent as
context far more than it tracked what the provider actually counts against a session or weekly limit
— the gate could read a window as nearly empty while the provider had already refused further work.
Every count now weighs each field by the provider's own price ratio to a fresh input token — output
at 5, a cache write at 1.25, a cache read at 0.1 — through one function, `weighTokenFields`, that
`container-sandbox.ts`'s `totalTokens` and the usage ledger's `weighLineUsage` both call, the former
by way of `weightedTokenCount`'s own rounding. Decided on #95; amends ADR 0004's unit, which named
tokens without saying how they were counted.

A run's own recorded spend also moved from the envelope's `usage`, which carries only the main loop's
own turns, to `modelUsage`, which sums every model a run touched — a run that delegated to a subagent
was undercounted by whatever that subagent spent.

## Why it went this way

**Price ratio, not a provider-published weight.** The provider documents no formula for how tokens
count against a session or weekly limit. It does price every current model by the same ratios to a
fresh input token, and Claude Code's own cost estimate already reads cache tokens "at the cached
token rate" — the same idea this budget document already leans on for `spendCeiling`. Using it here
does not claim to reproduce the provider's real limiting formula, only to stop the one certainly wrong
approximation: equal weight, which overcounts a cache read by a factor of ten and undercounts an
output token by a factor of five.

**Both counters, not just the run's own spend.** The usage ledger's `sumTokenFields` had the identical
equal-weight gap for the developer's own interactive usage. Leaving it unweighted would have left the
gate comparing a weighted run estimate against an unweighted window, which is the same mismatch this
change exists to remove.

## Considered options

- **The provider's undocumented utilization endpoint or headers**
  (`api/oauth/usage`, `anthropic-ratelimit-unified-5h-utilization`). Turned down: undocumented and
  rate limited, so building the gate around it risks the gate itself being throttled or broken by a
  change the provider owes nobody notice of.
- **Weighting by model**, which ADR 0004 already turned down for the run estimate, for the same
  reason: the provider publishes no per-model quota weights. This change weighs a token by which
  field it came from, not which model produced it, so it does not reopen that question.

## What this costs

The weights are a stand-in for a formula the provider does not publish, not a measured one — the same
caveat `DEFAULT_BUDGET`'s own tokens have always carried, now attached to how a token is counted as
well as to how many of them a window holds. `DEFAULT_BUDGET`'s allowances and sizes are scaled down by
0.3, not by the cache-read weight alone: no recorded run keeps its field breakdown to derive a real
ratio from, but `src/testing/budget-exhaustion.ts`'s fixture — built to weigh out to a real envelope's
`total_cost_usd` — weighs to about 0.3 of its own raw sum, and that is closer to a typical run's mix
than treating every token as a cache read would be. A machine whose own mix differs still needs the
developer's own recalibration against `state.json`, exactly as before this change.
Every run total recorded before this change is in the old, unweighted unit, and is not converted:
`state.json`'s runs are only ever appended to, never rewritten, so old figures sit beside new ones
indefinitely. The gate only ever reads the ones inside a window still open, so for as long as a
5-hour or weekly window straddles the change, it sums old-unit totals — which counted a cache read,
most of a run's tokens, at a full token rather than a tenth — against allowances cut on the assumption
that every run from here on is counted the new way. That reads as more spent than is true, which is
the direction this design already treats as safe, and it corrects itself once every straddling window
has reset; nothing in `state.json` itself needs migrating.

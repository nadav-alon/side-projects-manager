/**
 * What the agent CLI says, and all it says, once the provider limit refuses a
 * run — an example fixture for tests, not something any adapter reads: the
 * container adapter's own `LIMIT_REFUSAL` regex is what recognises wording
 * shaped like this, and a `RunOutcome`/`ReviewOutcome` carries it verbatim
 * once recognised.
 */
export const LIMIT_REFUSAL = "You've hit your session limit · resets 1pm (UTC)";

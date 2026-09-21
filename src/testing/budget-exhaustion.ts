/**
 * What the agent CLI says, and all it says, once `--max-budget-usd` stops a
 * run — an example fixture for tests, not something any adapter reads: the
 * container adapter's own `budgetExhaustedFromEnvelope` is what recognises an
 * envelope shaped like this, and a `RunOutcome`/`ReviewOutcome` carries the
 * quoted words once recognised.
 */

/** `BUDGET_EXHAUSTED_STDOUT`'s own `result`, meant to be read on its own. */
export const BUDGET_EXHAUSTED_JSON_RESULT =
  "Budget limit reached: spent $10.02, limit $10.00";

/**
 * The envelope `claude --print … --output-format json --max-budget-usd
 * <ceiling>` writes to stdout once a run spends past its ceiling, trimmed to
 * the fields a reader or the adapter cares about: `is_error: true`,
 * `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"`,
 * and a `result` meant to be read. `usage` is populated, as it is on a real
 * envelope: 202 turns spending $10.02 could not have moved zero tokens.
 */
export const BUDGET_EXHAUSTED_STDOUT = JSON.stringify({
  type: "result",
  subtype: "error_max_budget_usd",
  is_error: true,
  terminal_reason: "budget_exhausted",
  num_turns: 202,
  total_cost_usd: 10.02,
  usage: {
    input_tokens: 12_345,
    cache_creation_input_tokens: 30_210,
    cache_read_input_tokens: 610_000,
    output_tokens: 18_500,
  },
  permission_denials: [],
  result: BUDGET_EXHAUSTED_JSON_RESULT,
});

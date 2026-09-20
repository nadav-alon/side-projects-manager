/**
 * What the agent CLI says, and all it says, once a provider failure cuts a run
 * off — two example fixtures for tests, not something any adapter reads: the
 * container adapter's own `providerFailureFromEnvelope` and
 * `providerFailureFromProse` are what recognise shapes like these, and a
 * `RunOutcome`/`ReviewOutcome` carries the quoted words once recognised.
 */

/** `PROVIDER_FAILURE_STDOUT`'s own `result`, meant to be read on its own. */
export const PROVIDER_FAILURE_JSON_RESULT = "Request timed out";

/**
 * The envelope `claude --print … --output-format json` wrote to stdout under
 * a forced timeout (`API_TIMEOUT_MS=1`), trimmed to the fields a reader or the
 * adapter cares about: `is_error: true`, `terminal_reason: "api_error"`,
 * `api_error_status: null`, and a `result` meant to be read.
 */
export const PROVIDER_FAILURE_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: null,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
  permission_denials: [],
  result: PROVIDER_FAILURE_JSON_RESULT,
});

/**
 * What the agent CLI wrote, and the whole of what it wrote, to stdout during a
 * real provider failure — no JSON envelope, no stderr tag, exit non-zero.
 */
export const PROVIDER_FAILURE_PROSE =
  "API Error: No response from API (waited 3m, then 10m on the retry). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS or CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to wait longer.";

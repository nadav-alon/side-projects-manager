declare const modelNameBrand: unique symbol;

/**
 * The name of a model a run is to use, as the agent CLI's `--model` takes it:
 * an alias such as `sonnet` or a full model id.
 *
 * Passed through as written and never checked against a list of known models,
 * because any such list goes stale with the next release — the CLI is what
 * says whether it knows a name. The only check is on shape: a name must be
 * something that can be handed over as one argument at all.
 *
 * Branded, because a model name, a label and a repo slug are all strings, and
 * a run handed the wrong one fails only once the sandbox has started. Values
 * enter through `modelName` or `isModelName`.
 */
export type ModelName = string & { readonly [modelNameBrand]: true };

/** Whether `value` is non-empty and free of whitespace, which no model id carries. */
export function isModelName(value: string): value is ModelName {
  return /^\S+$/.test(value);
}

/** Narrows `value` to a `ModelName`, throwing if it cannot be one. */
export function modelName(value: string): ModelName {
  if (!isModelName(value)) {
    throw new TypeError(
      `Not a model name, expected a non-empty name without spaces: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

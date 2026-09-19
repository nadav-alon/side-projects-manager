import path from "node:path";

declare const transcriptPathBrand: unique symbol;

/**
 * An absolute path to a sandboxed run's own session transcript: either the
 * host directory `dockerCommand` mounts into the container for the agent CLI
 * to write one into, or the `.jsonl` file found there once the run has
 * ended — a `RunOutcome`, `ReviewOutcome`, `ApplyReviewOutcome` or
 * `RebaseOutcome` names the latter, so a run that hung or spent oddly can be
 * read back after its container is gone (`--rm` takes everything else with
 * it).
 *
 * Branded for the same reason `Checkout` is: it travels beside other strings
 * a caller must not swap it for. Values enter through `transcriptPath` or
 * `isTranscriptPath`.
 */
export type TranscriptPath = string & { readonly [transcriptPathBrand]: true };

/**
 * Whether `value` is a usable transcript path: absolute, and already in the
 * shape `path.join` produces, so two spellings of one path never read as two
 * different ones.
 */
export function isTranscriptPath(value: string): value is TranscriptPath {
  if (value === "" || !path.isAbsolute(value)) {
    return false;
  }
  if (value.length > 1 && value.endsWith(path.sep)) {
    return false;
  }
  return path.normalize(value) === value;
}

/** Narrows `value` to a `TranscriptPath`, throwing if it is not one. */
export function transcriptPath(value: string): TranscriptPath {
  if (!isTranscriptPath(value)) {
    throw new TypeError(
      `Not a transcript path: expected a normalised absolute path, got ${value}`,
    );
  }
  return value;
}

import { isNormalisedAbsolutePath } from "./normalised-absolute-path.ts";

declare const transcriptPathBrand: unique symbol;

/**
 * An absolute path to a sandboxed run's own session transcript: the `.jsonl`
 * file the agent CLI wrote inside its `TranscriptDirectory`, found there once
 * the run has ended — a `RunOutcome`, `ReviewOutcome`, `ApplyReviewOutcome` or
 * `RebaseOutcome` names it, so a run that hung or spent oddly can be read
 * back after its container is gone (`--rm` takes everything else with it).
 *
 * Distinct from `TranscriptDirectory`, the directory it is found in: the two
 * are different domain concepts — one is mounted into the container before
 * the run, the other is read off disk after it — and collapsing them into one
 * brand would let a directory be passed where a transcript file is meant, or
 * the reverse. Values enter through `transcriptPath` or `isTranscriptPath`.
 */
export type TranscriptPath = string & { readonly [transcriptPathBrand]: true };

/**
 * Whether `value` is a usable transcript path: absolute, and already in the
 * shape `path.join` produces, so two spellings of one path never read as two
 * different ones.
 */
export function isTranscriptPath(value: string): value is TranscriptPath {
  return isNormalisedAbsolutePath(value);
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

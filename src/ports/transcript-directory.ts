import { isNormalisedAbsolutePath } from "./normalised-absolute-path.ts";

declare const transcriptDirectoryBrand: unique symbol;

/**
 * An absolute path to the host directory `dockerCommand` mounts into a
 * sandboxed run's container, for the agent CLI to write its own session
 * transcript into — see `RunOptions.transcriptDirectory`. Made fresh per run
 * by `attempt`, so two runs in progress at once never write into the same
 * one, and kept once the container is gone, unlike the throwaway clone: the
 * whole point is a transcript that survives the `--rm` that deletes it.
 *
 * Distinct from `TranscriptPath`, the `.jsonl` file found inside it once the
 * run has ended: collapsing the two into one brand would let a directory be
 * passed where a transcript file is meant, or the reverse. Values enter
 * through `transcriptDirectory` or `isTranscriptDirectory`.
 */
export type TranscriptDirectory = string & {
  readonly [transcriptDirectoryBrand]: true;
};

/**
 * Whether `value` is a usable transcript directory: absolute, and already in
 * the shape `path.join` produces, so two spellings of one directory never
 * read as two different ones.
 */
export function isTranscriptDirectory(
  value: string,
): value is TranscriptDirectory {
  return isNormalisedAbsolutePath(value);
}

/** Narrows `value` to a `TranscriptDirectory`, throwing if it is not one. */
export function transcriptDirectory(value: string): TranscriptDirectory {
  if (!isTranscriptDirectory(value)) {
    throw new TypeError(
      `Not a transcript directory: expected a normalised absolute path, got ${value}`,
    );
  }
  return value;
}

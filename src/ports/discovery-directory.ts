import { isNormalisedAbsolutePath } from "./normalised-absolute-path.ts";

declare const discoveryDirectoryBrand: unique symbol;

/**
 * An absolute path to the host directory `dockerCommand` mounts into a
 * sandboxed run's container at `/discoveries`, for the agent to write one
 * JSON file per discovery into — see `RunOptions.discoveriesDirectory` and
 * CONTEXT.md's "Discovery". Made fresh per run by `attempt`, so two runs in
 * progress at once never write into the same one.
 *
 * Distinct from `TranscriptDirectory`, the sibling mount for the agent CLI's
 * own session log: collapsing the two into one brand would let either be
 * passed where the other is meant. Values enter through `discoveryDirectory`
 * or `isDiscoveryDirectory`.
 */
export type DiscoveryDirectory = string & {
  readonly [discoveryDirectoryBrand]: true;
};

/**
 * Whether `value` is a usable discoveries directory: absolute, and already in
 * the shape `path.join` produces, so two spellings of one directory never
 * read as two different ones.
 */
export function isDiscoveryDirectory(
  value: string,
): value is DiscoveryDirectory {
  return isNormalisedAbsolutePath(value);
}

/** Narrows `value` to a `DiscoveryDirectory`, throwing if it is not one. */
export function discoveryDirectory(value: string): DiscoveryDirectory {
  if (!isDiscoveryDirectory(value)) {
    throw new TypeError(
      `Not a discoveries directory: expected a normalised absolute path, got ${value}`,
    );
  }
  return value;
}

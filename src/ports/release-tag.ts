declare const releaseTagBrand: unique symbol;

/**
 * A release's git tag as a pinned package names it: `v` and a dotted
 * numeric version, `v0.5.1`. Branded, so a branch name or a free-text
 * fragment of a dependency spec cannot stand in for one. Values enter
 * through `releaseTag` or `isReleaseTag`.
 */
export type ReleaseTag = string & { readonly [releaseTagBrand]: true };

const SHAPE = /^v\d+(?:\.\d+)*$/;

/** Whether `value` is shaped like a release tag. */
export function isReleaseTag(value: string): value is ReleaseTag {
  return SHAPE.test(value);
}

/** Narrows `value` to a `ReleaseTag`, throwing if it is not shaped like one. */
export function releaseTag(value: string): ReleaseTag {
  if (!isReleaseTag(value)) {
    throw new TypeError(`Not a release tag, expected v1.2.3: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Whether `tag` names an earlier version than `latest`, compared part by
 * part as numbers, a missing part reading as zero.
 */
export function isOlderTag(tag: ReleaseTag, latest: ReleaseTag): boolean {
  const mine = tag.slice(1).split(".").map(Number);
  const theirs = latest.slice(1).split(".").map(Number);
  for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
    const difference = (mine[i] ?? 0) - (theirs[i] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

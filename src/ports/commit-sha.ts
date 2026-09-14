declare const commitShaBrand: unique symbol;

/**
 * A git commit hash, full or abbreviated: what a run's commits are named by,
 * and what the checkout fetches the branch back to find.
 *
 * Branded, so a stray line of an agent's output cannot stand in for one.
 * Values enter through `commitSha` or `isCommitSha`, which are the only places
 * the shape is checked.
 */
export type CommitSha = string & { readonly [commitShaBrand]: true };

/**
 * Git's own object id alphabet, at the lengths it hands out: an abbreviation of
 * at least 7, or a full hash — 40 characters under SHA-1, 64 under SHA-256.
 */
const SHAPE = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/;

/** Whether `value` is shaped like a commit hash git would recognise. */
export function isCommitSha(value: string): value is CommitSha {
  return SHAPE.test(value);
}

/** Narrows `value` to a `CommitSha`, throwing if it is not shaped like one. */
export function commitSha(value: string): CommitSha {
  if (!isCommitSha(value)) {
    throw new TypeError(`Not a commit hash: ${JSON.stringify(value)}`);
  }
  return value;
}

declare const pullRequestLabelBrand: unique symbol;

/**
 * A label on a pull request, as GitHub names one: 1 to 50 characters, never
 * empty.
 *
 * Branded, so a free-text string cannot stand in for a value the host is
 * actually going to be asked to apply. Values enter through
 * `pullRequestLabel` or `isPullRequestLabel`. {@link REVIEWED_LABEL} and
 * {@link APPLIED_REVIEW_LABEL} are the two the loop applies today, per
 * `CONTEXT.md`'s "Review ticket" and "Apply-review ticket".
 */
export type PullRequestLabel = string & {
  readonly [pullRequestLabelBrand]: true;
};

/** GitHub's own limit on a label's length. */
const MAX_LENGTH = 50;

/** Whether `value` is shaped like a GitHub label: non-empty, up to 50 characters. */
export function isPullRequestLabel(value: string): value is PullRequestLabel {
  return value.length > 0 && value.length <= MAX_LENGTH;
}

/** Narrows `value` to a `PullRequestLabel`, throwing if it is not shaped like one. */
export function pullRequestLabel(value: string): PullRequestLabel {
  if (!isPullRequestLabel(value)) {
    throw new TypeError(
      `Not a pull request label: expected 1 to ${MAX_LENGTH} characters, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** What a review ticket's pull request is labelled once findings are confirmed on it. */
export const REVIEWED_LABEL = pullRequestLabel("reviewed");

/** What an apply-review ticket's pull request is labelled once it finishes. */
export const APPLIED_REVIEW_LABEL = pullRequestLabel("applied-review");

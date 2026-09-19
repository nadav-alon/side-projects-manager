import path from "node:path";

declare const keptSummaryPathBrand: unique symbol;

/**
 * An absolute path to a summary kept in the manager home because it could
 * not be published: what the journal names in `summaryFailure.keptAt`.
 *
 * Branded for the same reason `Checkout` is: the entry point writes this
 * path down and the journal reads it back out of `journal.json`, so it must
 * not be swapped for any of the other strings travelling alongside it.
 * Values enter through `keptSummaryPath` or `isKeptSummaryPath`.
 */
export type KeptSummaryPath = string & {
  readonly [keptSummaryPathBrand]: true;
};

/** Whether `value` is a usable kept-summary path: a non-empty absolute path. */
export function isKeptSummaryPath(value: string): value is KeptSummaryPath {
  return value !== "" && path.isAbsolute(value);
}

/** Narrows `value` to a `KeptSummaryPath`, throwing if it is not one. */
export function keptSummaryPath(value: string): KeptSummaryPath {
  if (!isKeptSummaryPath(value)) {
    throw new TypeError(
      `Not a kept summary path: expected an absolute path, got ${value}`,
    );
  }
  return value;
}

/**
 * How many kept summaries the manager home keeps, oldest deleted first, every
 * time one is written — a domain rule every store implementation shares, the
 * same way `JOURNAL_LIMIT` caps the journal beside it.
 */
export const KEPT_SUMMARY_LIMIT = 20;

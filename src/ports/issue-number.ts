declare const issueNumberBrand: unique symbol;

/**
 * The number a ticket is known by in its tracker — `#59` — as opposed to its
 * priority or its database id: three numbers a ticket carries that must
 * never be swapped for one another. Created at the tracker boundary, from
 * whatever the adapter reads there.
 *
 * Branded, so a priority or a database id cannot stand in for one. Values
 * enter through `issueNumber` or `isIssueNumber`, both of which insist on a
 * positive integer — the one shape every tracker's issue numbers share.
 */
export type IssueNumber = number & { readonly [issueNumberBrand]: true };

/** Whether `value` is shaped like an issue number: a positive integer. */
export function isIssueNumber(value: number): value is IssueNumber {
  return Number.isSafeInteger(value) && value > 0;
}

/** Narrows `value` to an `IssueNumber`, throwing if it is not one. */
export function issueNumber(value: number): IssueNumber {
  if (!isIssueNumber(value)) {
    throw new TypeError(
      `Not an issue number, expected a positive integer: ${value}`,
    );
  }
  return value;
}

// Every file under `docs/adr/` opens with a four-digit number, claimed as the
// next free one when its branch is cut. Nothing else keeps two branches from
// claiming the same one, so the check over the merged tree lives here.

declare const adrNumberBrand: unique symbol;

/** The four-digit prefix of an ADR's file name, e.g. `0013`. */
export type AdrNumber = string & { readonly [adrNumberBrand]: true };

const ADR_FILE = /^(\d{4})-.+\.md$/;

/** The guard. */
export function isAdrNumber(value: string): value is AdrNumber {
  return /^\d{4}$/.test(value);
}

/** The constructor: narrows, or throws naming the offending value. */
export function adrNumber(value: string): AdrNumber {
  if (!isAdrNumber(value)) throw new Error(`Not an AdrNumber: ${JSON.stringify(value)}`);
  return value;
}

export interface AdrCollision {
  readonly number: AdrNumber;
  /** Every file claiming `number`, sorted; always at least two. */
  readonly files: readonly string[];
}

/**
 * The numbers more than one of `fileNames` claims, in ascending order. A name
 * that is not `NNNN-*.md` claims no number.
 */
export function adrCollisions(fileNames: readonly string[]): readonly AdrCollision[] {
  const byNumber = new Map<AdrNumber, string[]>();
  for (const name of fileNames) {
    const prefix = ADR_FILE.exec(name)?.[1];
    if (prefix === undefined) continue;
    const number = adrNumber(prefix);
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  return [...byNumber]
    .filter(([, files]) => files.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([number, files]) => ({ number, files: files.toSorted() }));
}

/** One line per collision naming the number and its files; empty when none. */
export function describeAdrCollisions(collisions: readonly AdrCollision[]): readonly string[] {
  return collisions.map(
    ({ number, files }) => `ADR ${number} is claimed by ${files.join(" and ")}`,
  );
}

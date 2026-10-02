import { iterationLimit, type IterationLimit } from "./iteration-limit.ts";
import { reserveFraction, type ReserveFraction } from "./reserve-fraction.ts";
import type { PullRequestBinding } from "./issue-tracker.ts";
import type { Size } from "./size.ts";
import { tokenCount, type TokenCount } from "./token-count.ts";
import { usd, type Usd } from "./usd.ts";

/**
 * What the developer is willing to let the mornings spend.
 *
 * What the provider does report of a window's own usage never reaches a
 * headless run in time to act on, so every allowance here is self-declared: a
 * number the developer states and then calibrates against the run costs the
 * state document accumulates. Being wrong is safe in one direction only,
 * which is why the reserve exists.
 */
/**
 * `spendCeiling`'s shape: one dollar figure for every size, or one figure per
 * size, keyed the way `sizes` is. `CONTEXT.md`'s "Spend ceiling" names the
 * concept this is.
 */
export type SpendCeiling = Usd | Record<Size, Usd>;

/**
 * The pull request ticket kinds `Budget.kinds` keys, spelled as a document
 * key: `applyReview` for the `apply-review` kind.
 */
export const PULL_REQUEST_KIND_KEYS = ["review", "applyReview", "rebase"] as const;

export type PullRequestKindKey = (typeof PULL_REQUEST_KIND_KEYS)[number];

export interface Budget {
  /** Tokens the 5-hour window is assumed to hold. */
  fiveHourAllowance: TokenCount;
  /** Tokens the weekly window is assumed to hold. */
  weeklyAllowance: TokenCount;
  /** The share of `weeklyAllowance` held back for the developer. */
  reserveFraction: ReserveFraction;
  /** The share of `fiveHourAllowance` held back for the developer. */
  fiveHourReserveFraction: ReserveFraction;
  /**
   * The most a single run may spend, enforced by the agent CLI itself: one
   * dollar figure for every size, or one figure per size, keyed the way
   * `sizes` is. `spendCeilingFor` resolves whichever form this holds down to
   * the one figure a given size sees.
   */
  spendCeiling: SpendCeiling;
  /**
   * The most iterations one invocation may have in progress at once. Raising
   * it multiplies the overshoot `spendCeiling` accepts; the README says by how
   * much.
   */
  maxConcurrentIterations: IterationLimit;
  /**
   * The tokens each ticket size is worth, keyed by the size label a ticket
   * may carry. What the gate charges as a run's estimate, whatever model the
   * run uses; see `CONTEXT.md`'s "Run estimate".
   */
  sizes: Record<Size, TokenCount>;
  /**
   * The tokens a pull request ticket's run is worth, keyed by its kind, in
   * place of any size. A kind it omits is charged `sizes[unsizedCountsAs]`
   * instead, so a document that names only some kinds leaves the rest on
   * the size.
   */
  kinds: Partial<Record<PullRequestKindKey, TokenCount>>;
  /**
   * The size an unsized ticket counts as, and the size a pull request
   * ticket's spend ceiling is read at, since it never inherits its parent's
   * size. Also the size its run estimate is read at where `kinds` omits its
   * kind.
   */
  unsizedCountsAs: Size;
  /**
   * A 5-hour reset instant the developer saw on the provider's own display,
   * which settles a boundary the ledger can only infer. See `UsageLedger`
   * for why the inference needs settling, and `parseUsageWindows` for what a
   * reset already past means as against one still to come.
   *
   * Absent for most machines, and going stale is not a failure: an instant
   * from last week still correctly says the blocks before it have ended, and
   * the inference takes over from there. Ahead is the unforgiving direction —
   * one more than 5 hours out names a block that has not opened, and the
   * ledger refuses it rather than state an empty window.
   *
   * It sits in the budget document because it is the developer's to write and
   * the loop's only to read, which is what separates that document from the
   * state one.
   */
  observedResetAt?: Date;
}

/**
 * The budget a machine with no budget document runs under.
 *
 * Deliberately cautious rather than accurate: the allowances are a starting
 * point, not a measurement, and the ledger under-counts beneath them. Half
 * the week is held back because the developer's own Opus work is the half
 * this whole design exists to protect. The 5-hour window holds nothing back
 * by default, since a machine that declares no `fiveHourReserveFraction`
 * should behave exactly as it did before that setting existed.
 *
 * These numbers are never revised by anything running here — nothing writes
 * the budget document, and what the provider does report of a window's own
 * usage never reaches a headless run, so there is nothing to derive a true
 * allowance from. They are the developer's to raise or lower by hand in
 * `budget.json`, against the run costs `state.json` accumulates.
 *
 * Expressed in `weightedTokenCount`'s tokens: scaled down by 0.3 from a
 * straight sum of usage fields, the ratio a realistic mix of input, output
 * and cache tokens weighs to (see ADR 0010), rather than the cache-read
 * weight alone. The developer's own recalibration against `state.json` is
 * what corrects it for a machine whose own mix differs.
 */
export const DEFAULT_BUDGET: Budget = {
  fiveHourAllowance: tokenCount(15_000_000),
  weeklyAllowance: tokenCount(150_000_000),
  reserveFraction: reserveFraction(0.5),
  fiveHourReserveFraction: reserveFraction(0),
  spendCeiling: usd(10),
  maxConcurrentIterations: iterationLimit(1),
  sizes: {
    S: tokenCount(150_000),
    M: tokenCount(600_000),
    L: tokenCount(1_500_000),
    XL: tokenCount(3_000_000),
  },
  kinds: {
    review: tokenCount(250_000),
    applyReview: tokenCount(450_000),
    rebase: tokenCount(100_000),
  },
  unsizedCountsAs: "M",
};

/**
 * The ceiling `spendCeiling` names for `size`: the one figure it declares,
 * if it declares just one for every size, or that size's own figure if it is
 * keyed by size.
 */
export function spendCeilingFor(size: Size, spendCeiling: SpendCeiling): Usd {
  return typeof spendCeiling === "number" ? spendCeiling : spendCeiling[size];
}

/** `kind`, a pull request ticket's kind, as `Budget.kinds` spells it. */
export function pullRequestKindKey(
  kind: PullRequestBinding["kind"],
): PullRequestKindKey {
  return kind === "apply-review" ? "applyReview" : kind;
}

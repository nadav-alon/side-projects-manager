import { reserveFraction, type ReserveFraction } from "./reserve-fraction.ts";
import { tokenCount, type TokenCount } from "./token-count.ts";
import { usd, type Usd } from "./usd.ts";

/**
 * What the developer is willing to let the mornings spend.
 *
 * The provider reports consumption but never remaining quota, so every
 * allowance here is self-declared: a number the developer states and then
 * calibrates against the run costs the state document accumulates. Being
 * wrong is safe in one direction only, which is why the reserve exists.
 */
export interface Budget {
  /** Tokens the 5-hour window is assumed to hold. */
  fiveHourAllowance: TokenCount;
  /** Tokens the weekly window is assumed to hold. */
  weeklyAllowance: TokenCount;
  /** The share of `weeklyAllowance` held back for the developer. */
  reserveFraction: ReserveFraction;
  /** The most a single run may spend, enforced by the agent CLI itself. */
  spendCeiling: Usd;
  /**
   * A 5-hour reset instant the developer saw on the provider's own display,
   * which settles a boundary the ledger can only infer. See `UsageLedger`
   * for why the inference needs settling, and `parseUsageWindows` for what a
   * reset already past means as against one still to come.
   *
   * Absent for most machines, and going stale is not a failure: an instant
   * from last week still correctly says the blocks before it have ended, and
   * the inference takes over from there. It sits in the budget document
   * because it is the developer's to write and the loop's only to read, which
   * is what separates that document from the state one.
   */
  observedResetAt?: Date;
}

/**
 * The budget a machine with no budget document runs under.
 *
 * Deliberately cautious rather than accurate: the allowances are a starting
 * point, not a measurement, and the ledger under-counts beneath them. Half
 * the week is held back because the developer's own Opus work is the half
 * this whole design exists to protect.
 *
 * These numbers are never revised by anything running here — nothing writes
 * the budget document, and the provider reports consumption but never
 * remaining quota, so there is nothing to derive a true allowance from. They
 * are the developer's to raise or lower by hand in `budget.json`, against the
 * run costs `state.json` accumulates.
 */
export const DEFAULT_BUDGET: Budget = {
  fiveHourAllowance: tokenCount(50_000_000),
  weeklyAllowance: tokenCount(500_000_000),
  reserveFraction: reserveFraction(0.5),
  spendCeiling: usd(5),
};

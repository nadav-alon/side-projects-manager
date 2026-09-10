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
  /** The hard per-run cap the agent CLI enforces on a single run. */
  spendCeiling: Usd;
}

/**
 * The budget a machine with no budget document runs under.
 *
 * Deliberately cautious rather than accurate: the allowances are a starting
 * point, not a measurement, and the ledger under-counts beneath them. Half
 * the week is held back because the developer's own Opus work is the half
 * this whole design exists to protect. Calibrate against `state.json`, where
 * every run's real cost is recorded.
 */
export const DEFAULT_BUDGET: Budget = {
  fiveHourAllowance: tokenCount(50_000_000),
  weeklyAllowance: tokenCount(500_000_000),
  reserveFraction: reserveFraction(0.5),
  spendCeiling: usd(5),
};

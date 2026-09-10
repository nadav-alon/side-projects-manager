import type {
  Budget,
  ReserveFraction,
  TokenCount,
  UsageWindow,
  UsageWindows,
} from "./ports/index.ts";
import { tokenCount } from "./ports/index.ts";

/** Which window refused a run. */
export type StandDownReason =
  /** Spending more of the week would eat into the developer's reserve. */
  | "weekly-reserve"
  /** The current 5-hour block is spent, whatever the week looks like. */
  | "five-hour-window";

/** Why the loop stood down, and everything the developer needs to see why. */
export interface StandDown {
  reason: StandDownReason;
  /** What that window had consumed when the gate looked. */
  tokensUsed: TokenCount;
  /** The most it may consume before the gate refuses. */
  spendable: TokenCount;
  /** When that window resets, which is when headroom returns. */
  resetsAt: Date;
}

/**
 * Whether a run may start, given the windows in force and what the developer
 * declared they are willing to spend. `undefined` is the go-ahead.
 *
 * Two windows, refusing for two different reasons. The weekly window is
 * measured against the part of the allowance the reserve does not hold back,
 * so the developer's own interactive work still has a week's worth of room
 * after the mornings have had theirs. The 5-hour window has no reserve of its
 * own — the reserve is a share of the week — and is measured against the
 * whole allowance, because a spent block is a wall the loop should not walk
 * into rather than headroom to ration.
 *
 * The week is checked first: when both windows refuse, the one that resets
 * later is the one worth telling the developer about.
 *
 * Every number here is an inference. The provider reports consumption and
 * never remaining quota, and the ledger cannot see the developer's usage from
 * Claude chat or another machine, so the windows read low. The reserve is
 * what absorbs that, and it is why the arithmetic rounds the developer's way
 * throughout: a reserve that does not divide evenly is held back whole.
 */
export function budgetGate(
  windows: UsageWindows,
  budget: Budget,
): StandDown | undefined {
  const weekly = refusal(
    "weekly-reserve",
    windows.weekly,
    spendableOf(budget.weeklyAllowance, budget.reserveFraction),
  );
  if (weekly !== undefined) {
    return weekly;
  }

  return refusal(
    "five-hour-window",
    windows.fiveHour,
    budget.fiveHourAllowance,
  );
}

/**
 * The stand-down `window` calls for, or `undefined` when it still has room.
 *
 * A window that has consumed exactly what it may consume has not overrun it,
 * so the boundary is a go: the reserve is intact to the token.
 */
function refusal(
  reason: StandDownReason,
  window: UsageWindow,
  spendable: TokenCount,
): StandDown | undefined {
  if (window.tokensUsed <= spendable) {
    return undefined;
  }
  return {
    reason,
    tokensUsed: window.tokensUsed,
    spendable,
    resetsAt: window.resetsAt,
  };
}

/**
 * What is left of `allowance` once the reserve is held back.
 *
 * The reserve is taken out and rounded up, rather than the remainder being
 * computed as `allowance * (1 - reserveFraction)`. Both say the same thing in
 * arithmetic and not in floating point: a reserve of 0.9 against a
 * 500,000,000-token week comes out a token short the second way, and a
 * reserve that quietly shrinks is the one mistake the gate may not make.
 */
function spendableOf(
  allowance: TokenCount,
  reserveFraction: ReserveFraction,
): TokenCount {
  return tokenCount(allowance - Math.ceil(allowance * reserveFraction));
}

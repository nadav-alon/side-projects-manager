import type {
  Budget,
  ReserveFraction,
  RunCost,
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
  /** When that window resets, which is when work could resume. */
  resetsAt: Date;
}

/**
 * Whether a run may start, given the windows in force, what the mornings have
 * already spent, and what the developer declared they are willing to spend.
 * `undefined` is the go-ahead.
 *
 * Two windows, refusing for two different reasons. The weekly window is
 * measured against the part of the allowance the reserve does not hold back,
 * so the developer's own interactive work still has a week's worth of room
 * after the mornings have had theirs. The 5-hour window has no reserve of its
 * own — the reserve is a share of the week — and is measured against the
 * whole allowance, because a spent block is a wall the loop should not walk
 * into rather than a supply to ration.
 *
 * When both windows refuse, the developer hears about whichever resets later:
 * that is when work could actually resume, and a trigger that came back at the
 * earlier instant would only stand down again.
 *
 * `ownSpend` is required rather than defaulting to none: a gate that counted
 * no runs is not a cautious gate, it is the under-counting one the state
 * document exists to fix, and a caller that forgot to pass it should not
 * compile.
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
  ownSpend: readonly RunCost[],
): StandDown | undefined {
  const weekly = refusal(
    "weekly-reserve",
    windows.weekly,
    spendableOf(budget.weeklyAllowance, budget.reserveFraction),
    ownSpend,
  );
  const fiveHour = refusal(
    "five-hour-window",
    windows.fiveHour,
    budget.fiveHourAllowance,
    ownSpend,
  );

  if (weekly !== undefined && fiveHour !== undefined) {
    return fiveHour.resetsAt > weekly.resetsAt ? fiveHour : weekly;
  }
  return weekly ?? fiveHour;
}

/**
 * The stand-down `window` calls for, or `undefined` when it still has room.
 *
 * A window that has consumed exactly what it may consume has not overrun it,
 * so the boundary is a go: the reserve is intact to the token. What the run
 * about to start will itself spend is not subtracted here — the spend ceiling
 * is what bounds that, and it is the deliberate overshoot the gate accepts
 * between one check and the next.
 */
function refusal(
  reason: StandDownReason,
  window: UsageWindow,
  spendable: TokenCount,
  ownSpend: readonly RunCost[],
): StandDown | undefined {
  const tokensUsed = consumedIn(window, ownSpend);
  if (tokensUsed <= spendable) {
    return undefined;
  }
  return { reason, tokensUsed, spendable, resetsAt: window.resetsAt };
}

/**
 * Everything `window` has consumed: what the ledger can see, plus what the
 * mornings spent inside it.
 *
 * The two are added rather than one being trusted, because the ledger cannot
 * see a run at all. It reads this machine's session logs, and a run writes its
 * log inside a container that is thrown away when it ends — so a morning that
 * spent the week leaves the ledger reporting the same total it reported
 * before. A gate that read only the ledger would ration the developer's own
 * typing and never the thing it exists to bound.
 *
 * This holds only while runs are invisible to the ledger. If the sandbox ever
 * keeps its logs where the ledger reads them, the sum below starts counting
 * every run twice, and this is the place that has to know.
 */
function consumedIn(
  window: UsageWindow,
  ownSpend: readonly RunCost[],
): TokenCount {
  const mornings = ownSpend
    .filter((run) => run.at.getTime() >= window.openedAt.getTime())
    .reduce((total, run) => total + run.tokensUsed, 0);
  return tokenCount(window.tokensUsed + mornings);
}

/**
 * What is left of `allowance` once the reserve is held back.
 *
 * The reserve is taken out and rounded up, rather than the remainder being
 * computed as `allowance * (1 - reserveFraction)`. The two agree in arithmetic
 * and not in floating point, and the second form is not a token count: a
 * reserve of 0.5 against a 1,001-token week leaves 500.5, and 0.7 against
 * 1,000 leaves 300.00000000000006, so `tokenCount` below would throw on the
 * first and the gate would hand back a fractional spendable on the second.
 * Rounding the reserve up settles both the same way — a reserve that does not
 * divide evenly is held back whole, because a reserve that quietly shrinks is
 * the one mistake the gate may not make.
 */
function spendableOf(
  allowance: TokenCount,
  reserveFraction: ReserveFraction,
): TokenCount {
  return tokenCount(allowance - Math.ceil(allowance * reserveFraction));
}

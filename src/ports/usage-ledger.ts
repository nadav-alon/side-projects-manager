import type { TokenCount } from "./token-count.ts";

/**
 * One of the two windows the developer's consumption is measured against.
 *
 * A window is not a lookback from now. It opens at a boundary the provider
 * decides and resets there, so consumption inside it is what counts and
 * `resetsAt` is how long the loop has to wait for headroom to return.
 */
export interface UsageWindow {
  /** When the window opened. Consumption before this instant is not counted. */
  openedAt: Date;
  /** When it resets and consumption returns to zero. */
  resetsAt: Date;
  /** Tokens consumed since `openedAt`. */
  tokensUsed: TokenCount;
}

/** The two windows in force at a given instant. */
export interface UsageWindows {
  /** The 5-hour window, opened by the first message of the current block. */
  fiveHour: UsageWindow;
  /** The weekly window, which opens on Sunday. */
  weekly: UsageWindow;
}

/**
 * Reports recent Claude token consumption, so the loop can decline to start
 * work that would eat into the reserve held back for the developer.
 *
 * Knowingly under-counts: it cannot see Claude chat or other machines. The
 * reserve is sized to absorb that.
 *
 * Blindness costs the 5-hour window a second way, and the reserve does not
 * cover this one. That window's boundary is inferred from the messages the
 * ledger can see, so a message it cannot see opens the real block earlier
 * than the inferred one. The error runs one way only: the inferred opening is
 * at or after the true opening, so the inferred reset is at or after the true
 * reset, and the loop stands down past the moment its headroom came back.
 * An inferred window that straddles a reset the ledger never saw is worse
 * still, counting spend from the block that has already ended against the
 * block now open. That is what `observedReset` is for, and it is the
 * developer who supplies it because they are the one who can see it.
 */
export interface UsageLedger {
  /**
   * The windows in force at `now`.
   *
   * `observedReset` is a true 5-hour boundary the developer read off the
   * provider's own display, and it settles what the logs can only suggest.
   * Absent means nobody has said, which is the ordinary case: the ledger
   * infers the boundary and lives with the bias above.
   */
  read(now: Date, observedReset?: Date): Promise<UsageWindows>;
}

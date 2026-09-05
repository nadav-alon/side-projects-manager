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
 */
export interface UsageLedger {
  /** The windows in force at `now`. */
  read(now: Date): Promise<UsageWindows>;
}

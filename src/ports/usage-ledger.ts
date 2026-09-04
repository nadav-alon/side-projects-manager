/** Rolling token totals for the two windows the developer is subject to. */
export interface UsageWindows {
  last5Hours: number;
  last7Days: number;
}

/**
 * Reports recent Claude token consumption, so the loop can decline to start
 * work that would eat into the reserve held back for the developer.
 *
 * The real implementation parses local session logs (#5) and knowingly
 * under-counts: it cannot see Claude chat or other machines. The gate that
 * consumes these totals is #12.
 */
export interface UsageLedger {
  /** Totals for the windows ending at `now`. */
  read(now: Date): Promise<UsageWindows>;
}

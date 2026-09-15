import type { UsageLedger, UsageWindows } from "../ports/index.ts";
import { tokenCount } from "../ports/index.ts";
import { FROZEN_NOW } from "./fake-clock.ts";

/**
 * The windows in force at `FROZEN_NOW`, with nothing spent in either. The
 * boundaries are written out rather than computed: deriving them from a
 * timestamp is the real ledger's job, and a fake that did it too would be
 * asserting its own arithmetic.
 */
export const NO_USAGE: UsageWindows = {
  fiveHour: {
    openedAt: FROZEN_NOW,
    resetsAt: new Date("2026-01-01T11:00:00.000Z"),
    tokensUsed: tokenCount(0),
  },
  weekly: {
    openedAt: new Date("2025-12-28T00:00:00.000Z"),
    resetsAt: new Date("2026-01-04T00:00:00.000Z"),
    tokensUsed: tokenCount(0),
  },
};

/**
 * `NO_USAGE` with `consumed` spent in the windows named, keeping the
 * boundaries the fake already declares. Tests that care what the gate makes
 * of a total say only the total.
 */
export function spent(consumed: {
  fiveHour?: number;
  weekly?: number;
}): UsageWindows {
  return {
    fiveHour: {
      ...NO_USAGE.fiveHour,
      tokensUsed: tokenCount(consumed.fiveHour ?? 0),
    },
    weekly: {
      ...NO_USAGE.weekly,
      tokensUsed: tokenCount(consumed.weekly ?? 0),
    },
  };
}

/** What `FakeUsageLedger.read` was called with, in the order it was called. */
export interface FakeRead {
  now: Date;
  observedReset?: Date;
}

/**
 * Reports whatever windows the test told it to. No usage until told.
 *
 * Sealed behind `reports`, so a test says what the ledger sees in one place
 * and the fake keeps one answer to the question rather than a settable field
 * beside a constructor saying the same thing twice.
 *
 * `read` takes the same arguments the port declares, `now` and
 * `observedReset` included, rather than the fixed windows a caller with no
 * arguments could only ever hand back one way — so a test against the loop
 * can see whether a reset it wrote into the budget document actually reached
 * the ledger, not just that the port's own type allows it to.
 */
export class FakeUsageLedger implements UsageLedger {
  #windows: UsageWindows = NO_USAGE;
  #windowsForReset = new Map<number, UsageWindows>();

  /** Every call `read` answered, in the order they arrived. */
  readonly reads: FakeRead[] = [];

  /** What the ledger reports from here on, for a read with no observed reset. */
  reports(windows: UsageWindows): void {
    this.#windows = windows;
  }

  /** What it will report, for a test that needs a boundary it did not name. */
  get reported(): UsageWindows {
    return this.#windows;
  }

  /**
   * What the ledger reports from here on for a read carrying `observedReset`,
   * in place of what `reports` set — so a test can tell a consultation that
   * named a reset apart from one that did not.
   */
  reportsForReset(observedReset: Date, windows: UsageWindows): void {
    this.#windowsForReset.set(observedReset.getTime(), windows);
  }

  async read(now: Date, observedReset?: Date): Promise<UsageWindows> {
    this.reads.push({
      now,
      ...(observedReset !== undefined && { observedReset }),
    });
    const windows =
      observedReset === undefined
        ? this.#windows
        : (this.#windowsForReset.get(observedReset.getTime()) ??
          this.#windows);
    return {
      fiveHour: { ...windows.fiveHour },
      weekly: { ...windows.weekly },
    };
  }
}

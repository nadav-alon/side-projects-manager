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

/** Reports whatever windows the test was built with. No usage by default. */
export class FakeUsageLedger implements UsageLedger {
  /** The windows the ledger reports. Tests reassign this to spend some. */
  windows: UsageWindows;

  constructor(windows: UsageWindows = NO_USAGE) {
    this.windows = windows;
  }

  async read(): Promise<UsageWindows> {
    return {
      fiveHour: { ...this.windows.fiveHour },
      weekly: { ...this.windows.weekly },
    };
  }
}

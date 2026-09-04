import type { UsageLedger, UsageWindows } from "../ports/index.ts";

/** Reports whatever totals the test set, and remembers when it was asked. */
export class FakeUsageLedger implements UsageLedger {
  readonly readsAt: Date[] = [];
  #windows: UsageWindows;

  constructor(windows: UsageWindows = { last5Hours: 0, last7Days: 0 }) {
    this.#windows = windows;
  }

  /** Sets the totals subsequent reads report. */
  setUsage(windows: UsageWindows): void {
    this.#windows = windows;
  }

  async read(now: Date): Promise<UsageWindows> {
    this.readsAt.push(now);
    return { ...this.#windows };
  }
}

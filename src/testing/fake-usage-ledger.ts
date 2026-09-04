import type { UsageLedger, UsageWindows } from "../ports/index.ts";

/** Reports whatever totals the test was built with. No usage by default. */
export class FakeUsageLedger implements UsageLedger {
  readonly #windows: UsageWindows;

  constructor(windows: UsageWindows = { last5Hours: 0, last7Days: 0 }) {
    this.#windows = windows;
  }

  async read(): Promise<UsageWindows> {
    return { ...this.#windows };
  }
}

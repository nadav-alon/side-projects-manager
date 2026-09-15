import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tokenCount } from "../ports/index.ts";
import { FROZEN_NOW } from "./fake-clock.ts";
import { FakeUsageLedger, NO_USAGE } from "./fake-usage-ledger.ts";

/** The ledger has no caller in the loop yet, so its contract is pinned here. */
describe("FakeUsageLedger", () => {
  it("reports no usage by default", async () => {
    const windows = await new FakeUsageLedger().read(FROZEN_NOW);

    assert.equal(windows.fiveHour.tokensUsed, 0);
    assert.equal(windows.weekly.tokensUsed, 0);
  });

  it("reports windows that open before they reset", async () => {
    const { fiveHour, weekly } = await new FakeUsageLedger().read(FROZEN_NOW);

    assert.ok(fiveHour.openedAt < fiveHour.resetsAt);
    assert.ok(weekly.openedAt < weekly.resetsAt);
    assert.equal(weekly.openedAt.getUTCDay(), 0, "the weekly window opens on a Sunday");
  });

  it("reports the usage it was given", async () => {
    const ledger = new FakeUsageLedger();
    ledger.reports({
      fiveHour: { ...NO_USAGE.fiveHour, tokensUsed: tokenCount(120_000) },
      weekly: { ...NO_USAGE.weekly, tokensUsed: tokenCount(3_400_000) },
    });

    const windows = await ledger.read(FROZEN_NOW);

    assert.equal(windows.fiveHour.tokensUsed, 120_000);
    assert.equal(windows.weekly.tokensUsed, 3_400_000);
  });

  it("records the instant and observed reset each read was asked with", async () => {
    const ledger = new FakeUsageLedger();
    const observedReset = new Date("2026-01-01T05:00:00.000Z");

    await ledger.read(FROZEN_NOW);
    await ledger.read(FROZEN_NOW, observedReset);

    assert.deepEqual(ledger.reads, [
      { now: FROZEN_NOW },
      { now: FROZEN_NOW, observedReset },
    ]);
  });

  it("answers a read naming an observed reset differently from one that names none", async () => {
    const ledger = new FakeUsageLedger();
    const observedReset = new Date("2026-01-01T05:00:00.000Z");
    ledger.reports({
      fiveHour: { ...NO_USAGE.fiveHour, tokensUsed: tokenCount(1_000) },
      weekly: NO_USAGE.weekly,
    });
    ledger.reportsForReset(observedReset, {
      fiveHour: { ...NO_USAGE.fiveHour, tokensUsed: tokenCount(9_000) },
      weekly: NO_USAGE.weekly,
    });

    const withoutReset = await ledger.read(FROZEN_NOW);
    const withReset = await ledger.read(FROZEN_NOW, observedReset);

    assert.equal(withoutReset.fiveHour.tokensUsed, 1_000);
    assert.equal(withReset.fiveHour.tokensUsed, 9_000);
  });
});

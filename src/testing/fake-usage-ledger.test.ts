import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tokenCount } from "../ports/index.ts";
import { FakeUsageLedger, NO_USAGE } from "./fake-usage-ledger.ts";

/** The ledger has no caller in the loop yet, so its contract is pinned here. */
describe("FakeUsageLedger", () => {
  it("reports no usage by default", async () => {
    const windows = await new FakeUsageLedger().read();

    assert.equal(windows.fiveHour.tokensUsed, 0);
    assert.equal(windows.weekly.tokensUsed, 0);
  });

  it("reports windows that open before they reset", async () => {
    const { fiveHour, weekly } = await new FakeUsageLedger().read();

    assert.ok(fiveHour.openedAt < fiveHour.resetsAt);
    assert.ok(weekly.openedAt < weekly.resetsAt);
    assert.equal(weekly.openedAt.getUTCDay(), 0, "the weekly window opens on a Sunday");
  });

  it("reports the usage it was given", async () => {
    const ledger = new FakeUsageLedger({
      fiveHour: { ...NO_USAGE.fiveHour, tokensUsed: tokenCount(120_000) },
      weekly: { ...NO_USAGE.weekly, tokensUsed: tokenCount(3_400_000) },
    });

    const windows = await ledger.read();

    assert.equal(windows.fiveHour.tokensUsed, 120_000);
    assert.equal(windows.weekly.tokensUsed, 3_400_000);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeUsageLedger } from "./fake-usage-ledger.ts";

/**
 * The other four fakes are driven through the loop itself. The ledger has no
 * caller until the budget gate (#12), so its contract is pinned here instead:
 * a test that sets usage gets that usage back.
 */
describe("FakeUsageLedger", () => {
  it("reports no usage by default", async () => {
    assert.deepEqual(await new FakeUsageLedger().read(), {
      last5Hours: 0,
      last7Days: 0,
    });
  });

  it("reports the usage it was given", async () => {
    const ledger = new FakeUsageLedger({
      last5Hours: 120_000,
      last7Days: 3_400_000,
    });

    assert.deepEqual(await ledger.read(), {
      last5Hours: 120_000,
      last7Days: 3_400_000,
    });
  });
});

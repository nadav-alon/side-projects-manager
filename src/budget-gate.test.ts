import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  budgetGate,
  invocationBudgetGate,
  spendCeilingForTicket,
} from "./budget-gate.ts";
import {
  DEFAULT_BUDGET,
  issueNumber,
  pullRequestUrl,
  recordRun,
  reserveFraction,
  tokenCount,
  usd,
  type Budget,
  type Ticket,
  type UsageWindows,
} from "./ports/index.ts";
import {
  FROZEN_NOW,
  LAST_WEEK,
  MANAGER,
  NO_USAGE,
  PILOT,
  SPENDABLE_THIS_WEEK,
  YESTERDAY,
  FakeClock,
  FakeStore,
  FakeUsageLedger,
  spent,
} from "./testing/index.ts";

const TICKET: Ticket = { repo: PILOT, number: issueNumber(7), title: "Add the thing" };

/** `TICKET`'s own run estimate: unsized, so `DEFAULT_BUDGET.unsizedCountsAs`'s tokens. */
const TICKET_ESTIMATE = DEFAULT_BUDGET.sizes[DEFAULT_BUDGET.unsizedCountsAs];

/**
 * `DEFAULT_BUDGET` with `TICKET`'s size charging nothing, so a test can pin
 * pure window arithmetic — consumption against what is spendable — without
 * the run estimate charged on top of it.
 */
function noEstimateBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    ...DEFAULT_BUDGET,
    sizes: { ...DEFAULT_BUDGET.sizes, [DEFAULT_BUDGET.unsizedCountsAs]: tokenCount(0) },
    ...overrides,
  };
}

/**
 * One invocation's gate, built the way `morningLoop` builds it: over a
 * snapshot of the state document's projects as the invocation read it.
 */
async function openGate(
  store: FakeStore,
  ledger: FakeUsageLedger,
  clock: FakeClock = new FakeClock(),
) {
  const state = await store.loadState();
  return invocationBudgetGate({ ledger, clock, store }, state.projects);
}

describe("invocationBudgetGate", () => {
  it("goes ahead while the reserve is intact", async () => {
    const store = new FakeStore();
    store.budget = noEstimateBudget();
    const ledger = new FakeUsageLedger();
    ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK - 1 }));
    const gate = await openGate(store, ledger);

    assert.equal((await gate.consult(TICKET, [])).standDown, undefined);
  });

  it("refuses rather than let the reserve be spent a token over", async () => {
    const store = new FakeStore();
    const ledger = new FakeUsageLedger();
    ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));
    const gate = await openGate(store, ledger);

    const { standDown: refusal } = await gate.consult(TICKET, []);

    assert.equal(refusal?.reason, "weekly-reserve");
    assert.equal(refusal?.tokensUsed, SPENDABLE_THIS_WEEK + 1);
    assert.equal(refusal?.spendable, SPENDABLE_THIS_WEEK);
  });

  it("refuses when the 5-hour window is spent, whatever the week looks like", async () => {
    const store = new FakeStore();
    const ledger = new FakeUsageLedger();
    ledger.reports(
      spent({ fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1, weekly: 0 }),
    );
    const gate = await openGate(store, ledger);

    const { standDown: refusal } = await gate.consult(TICKET, []);

    assert.equal(refusal?.reason, "five-hour-window");
  });

  it("names whichever window resets later when both refuse", async () => {
    const store = new FakeStore();
    const ledger = new FakeUsageLedger();
    ledger.reports(
      spent({
        fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        weekly: SPENDABLE_THIS_WEEK + 1,
      }),
    );
    const gate = await openGate(store, ledger);

    assert.equal(
      (await gate.consult(TICKET, [])).standDown?.reason,
      "weekly-reserve",
    );
  });

  it("names the 5-hour window when it is the one that outlasts the week", async () => {
    const store = new FakeStore();
    const ledger = new FakeUsageLedger();
    ledger.reports({
      fiveHour: {
        ...NO_USAGE.fiveHour,
        resetsAt: new Date("2026-01-05T00:00:00.000Z"),
        tokensUsed: tokenCount(DEFAULT_BUDGET.fiveHourAllowance + 1),
      },
      weekly: {
        ...NO_USAGE.weekly,
        tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
      },
    });
    const gate = await openGate(store, ledger);

    assert.equal(
      (await gate.consult(TICKET, [])).standDown?.reason,
      "five-hour-window",
    );
  });

  describe("reading the ledger", () => {
    it("reads it at the clock's instant, naming no reset by default", async () => {
      const store = new FakeStore();
      const ledger = new FakeUsageLedger();
      const gate = await openGate(store, ledger);

      await gate.consult(TICKET, []);

      assert.deepEqual(ledger.reads, [{ now: FROZEN_NOW }]);
    });

    it("hands it the observed reset the budget declares", async () => {
      const store = new FakeStore();
      const observedResetAt = new Date("2026-01-01T06:00:00.000Z");
      store.budget = { ...DEFAULT_BUDGET, observedResetAt };
      const ledger = new FakeUsageLedger();
      const gate = await openGate(store, ledger);

      await gate.consult(TICKET, []);

      assert.deepEqual(ledger.reads, [
        { now: FROZEN_NOW, observedReset: observedResetAt },
      ]);
    });
  });

  it("reads the budget document afresh on every consultation, not once when built", async () => {
    const store = new FakeStore();
    store.budget = {
      ...noEstimateBudget(),
      weeklyAllowance: tokenCount(1_000),
      reserveFraction: reserveFraction(0.5),
    };
    const ledger = new FakeUsageLedger();
    ledger.reports(spent({ weekly: 600 }));
    const gate = await openGate(store, ledger);

    const before = await gate.consult(TICKET, []);
    store.budget = { ...store.budget, reserveFraction: reserveFraction(0) };
    const after = await gate.consult(TICKET, []);

    assert.equal(before.standDown?.reason, "weekly-reserve");
    assert.equal(after.standDown, undefined);
  });

  it("hands back the budget document it read, for what the loop needs from it besides the verdict", async () => {
    const store = new FakeStore();
    store.budget = { ...DEFAULT_BUDGET, reserveFraction: reserveFraction(0) };
    const ledger = new FakeUsageLedger();
    const gate = await openGate(store, ledger);

    const { budget } = await gate.consult(TICKET, []);

    assert.deepEqual(budget, store.budget);
  });

  /**
   * The ledger reads this machine's session logs, and a run writes its log
   * inside a container that is thrown away when it ends — so a morning's own
   * spend reaches the gate through the state document or not at all.
   */
  describe("what the state document records", () => {
    it("counts a run recorded before the gate was built, the ledger cannot see", async () => {
      const store = new FakeStore();
      store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
      });
      const ledger = new FakeUsageLedger();
      ledger.reports(spent({ weekly: 0 }));
      const gate = await openGate(store, ledger);

      assert.equal(
        (await gate.consult(TICKET, [])).standDown?.reason,
        "weekly-reserve",
      );
    });

    it("counts a run recorded against the live map after the gate was built", async () => {
      const store = new FakeStore();
      const ledger = new FakeUsageLedger();
      ledger.reports(spent({ weekly: 0 }));
      const state = await store.loadState();
      const projects = new Map(state.projects);
      const gate = invocationBudgetGate(
        { ledger, clock: new FakeClock(), store },
        projects,
      );

      const before = await gate.consult(TICKET, []);
      projects.set(
        PILOT,
        recordRun(projects.get(PILOT), {
          at: FROZEN_NOW,
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        }),
      );
      const after = await gate.consult(TICKET, []);

      assert.equal(before.standDown, undefined);
      assert.equal(after.standDown?.reason, "weekly-reserve");
    });

    it("counts every project's runs, not just the ticket's own", async () => {
      const store = new FakeStore();
      store.markWorked(MANAGER, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
      });
      const ledger = new FakeUsageLedger();
      ledger.reports(spent({ weekly: 0 }));
      const gate = await openGate(store, ledger);

      assert.equal(
        (await gate.consult(TICKET, [])).standDown?.reason,
        "weekly-reserve",
      );
    });

    it("ignores runs from before the window opened", async () => {
      const store = new FakeStore();
      store.markWorked(PILOT, LAST_WEEK, {
        at: LAST_WEEK,
        tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
      });
      const ledger = new FakeUsageLedger();
      ledger.reports(spent({ weekly: 0 }));
      const gate = await openGate(store, ledger);

      assert.equal((await gate.consult(TICKET, [])).standDown, undefined);
    });

    it("leaves a run out of the 5-hour window it predates", async () => {
      const store = new FakeStore();
      store.budget = noEstimateBudget();
      store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(1),
      });
      const ledger = new FakeUsageLedger();
      ledger.reports(
        spent({ fiveHour: DEFAULT_BUDGET.fiveHourAllowance, weekly: 0 }),
      );
      const gate = await openGate(store, ledger);

      assert.equal((await gate.consult(TICKET, [])).standDown, undefined);
    });

    it("adds them to what the ledger did see", async () => {
      const store = new FakeStore();
      store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(2),
      });
      const ledger = new FakeUsageLedger();
      ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK - 1 }));
      const gate = await openGate(store, ledger);

      const { standDown: refusal } = await gate.consult(TICKET, []);

      assert.equal(refusal?.reason, "weekly-reserve");
      assert.equal(refusal?.tokensUsed, SPENDABLE_THIS_WEEK + 1);
    });
  });

  /**
   * The estimate resolution itself — sizes, `unsizedCountsAs`, and a review
   * never inheriting its parent's size — proven against `DEFAULT_BUDGET`'s
   * real sizes, since a zeroed one would prove nothing about them.
   */
  describe("the run estimate a consultation charges", () => {
    it("carries the estimate charged on a go-ahead, since standDown has nothing to carry it on", async () => {
      const store = new FakeStore();
      const ledger = new FakeUsageLedger();
      const gate = await openGate(store, ledger);

      const consultation = await gate.consult(TICKET, []);

      assert.equal(consultation.standDown, undefined);
      assert.equal(consultation.estimateCharged, TICKET_ESTIMATE);
    });

    it("carries the same estimate on a refusal", async () => {
      const store = new FakeStore();
      const ledger = new FakeUsageLedger();
      ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));
      const gate = await openGate(store, ledger);

      const consultation = await gate.consult(TICKET, []);

      assert.equal(consultation.standDown?.estimateCharged, TICKET_ESTIMATE);
      assert.equal(consultation.estimateCharged, TICKET_ESTIMATE);
    });

    it("charges a sized ticket its size's tokens", async () => {
      const store = new FakeStore();
      const ledger = new FakeUsageLedger();
      const gate = await openGate(store, ledger);
      const sized: Ticket = {
        ...TICKET,
        sizeLabel: { kind: "declared", size: "XL" },
      };

      const { estimateCharged } = await gate.consult(sized, []);

      assert.equal(estimateCharged, DEFAULT_BUDGET.sizes.XL);
    });

    for (const kind of ["review", "apply-review", "rebase"] as const) {
      it(`charges a ${kind} ticket unsizedCountsAs, even carrying its own declared size`, async () => {
        const store = new FakeStore();
        const ledger = new FakeUsageLedger();
        const gate = await openGate(store, ledger);
        const pullRequestTicket: Ticket = {
          ...TICKET,
          pullRequest: {
            kind,
            url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/1"),
          },
          sizeLabel: { kind: "declared", size: "XL" },
        };

        const { estimateCharged } = await gate.consult(pullRequestTicket, []);

        assert.equal(
          estimateCharged,
          DEFAULT_BUDGET.sizes[DEFAULT_BUDGET.unsizedCountsAs],
        );
      });
    }

    it("charges the consultation only the selected ticket's own estimate, not the tickets in progress", async () => {
      const store = new FakeStore();
      const ledger = new FakeUsageLedger();
      const gate = await openGate(store, ledger);
      const first: Ticket = {
        ...TICKET,
        number: issueNumber(7),
        sizeLabel: { kind: "declared", size: "S" },
      };
      const second: Ticket = {
        ...TICKET,
        number: issueNumber(8),
        sizeLabel: { kind: "declared", size: "L" },
      };

      await gate.consult(first, []);
      const { estimateCharged } = await gate.consult(second, [first]);

      assert.equal(estimateCharged, DEFAULT_BUDGET.sizes.L);
    });
  });
});

/**
 * `spendCeilingForTicket` resolves the same size `runEstimate` charges, so
 * these pin the size resolution against a per-size ceiling rather than
 * re-proving it: sizes, `unsizedCountsAs`, and a review never inheriting its
 * parent's size.
 */
describe("spendCeilingForTicket", () => {
  const PER_SIZE_CEILING = { S: usd(3), M: usd(5), L: usd(10), XL: usd(20) };

  it("gives the flat ceiling to every size, when spendCeiling is one number", () => {
    const budget: Budget = { ...DEFAULT_BUDGET, spendCeiling: usd(2.5) };
    const sized: Ticket = { ...TICKET, sizeLabel: { kind: "declared", size: "XL" } };

    assert.equal(spendCeilingForTicket(sized, budget), 2.5);
  });

  it("gives a sized ticket its own size's ceiling", () => {
    const budget: Budget = { ...DEFAULT_BUDGET, spendCeiling: PER_SIZE_CEILING };
    const sized: Ticket = { ...TICKET, sizeLabel: { kind: "declared", size: "L" } };

    assert.equal(spendCeilingForTicket(sized, budget), 10);
  });

  it("gives an unsized ticket unsizedCountsAs's ceiling", () => {
    const budget: Budget = {
      ...DEFAULT_BUDGET,
      spendCeiling: PER_SIZE_CEILING,
      unsizedCountsAs: "S",
    };

    assert.equal(spendCeilingForTicket(TICKET, budget), 3);
  });

  for (const kind of ["review", "apply-review", "rebase"] as const) {
    it(`gives a ${kind} ticket unsizedCountsAs's ceiling, even carrying its own declared size`, () => {
      const budget: Budget = {
        ...DEFAULT_BUDGET,
        spendCeiling: PER_SIZE_CEILING,
        unsizedCountsAs: "M",
      };
      const pullRequestTicket: Ticket = {
        ...TICKET,
        pullRequest: {
          kind,
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/1"),
        },
        sizeLabel: { kind: "declared", size: "XL" },
      };

      assert.equal(spendCeilingForTicket(pullRequestTicket, budget), 5);
    });
  }
});

/**
 * The window arithmetic `invocationBudgetGate` calls with what it assembled.
 * What is pinned here is the arithmetic the consultation-level tests above
 * cannot see the reason for: the reserve is held back whole, and a reserve
 * that quietly loses a token to floating point is the one mistake the gate
 * may not make.
 */
describe("budgetGate", () => {
  function budget(overrides: Partial<Budget> = {}): Budget {
    return { ...DEFAULT_BUDGET, ...overrides };
  }

  function weekly(tokensUsed: number): UsageWindows {
    return {
      ...NO_USAGE,
      weekly: { ...NO_USAGE.weekly, tokensUsed: tokenCount(tokensUsed) },
    };
  }

  describe("the weekly reserve", () => {
    /**
     * A reserve that does not divide evenly is held back whole. `1001 * 0.5`
     * leaves half a token over, and the half goes to the developer.
     */
    it("rounds a reserve that does not divide evenly the developer's way", () => {
      const week = noEstimateBudget({
        weeklyAllowance: tokenCount(1_001),
        reserveFraction: reserveFraction(0.5),
      });

      assert.equal(budgetGate(weekly(500), week, [], TICKET, []), undefined);
      assert.equal(
        budgetGate(weekly(501), week, [], TICKET, [])?.reason,
        "weekly-reserve",
      );
      assert.equal(
        budgetGate(weekly(501), week, [], TICKET, [])?.spendable,
        500,
      );
    });

    /**
     * What `allowance * (1 - reserveFraction)` would not give: `1001 * 0.5` is
     * `500.5` and `1000 * 0.3` is `300.00000000000006`, neither of which is a
     * token count. The gate reports a spendable figure to the developer and
     * compares it against whole tokens, so it may never be a fraction.
     */
    it("leaves a whole number of tokens spendable at every reserve", () => {
      for (const allowance of [1_001, 1_000, 999, 500_000_000, 7]) {
        for (let hundredths = 0; hundredths < 100; hundredths += 1) {
          const week = budget({
            weeklyAllowance: tokenCount(allowance),
            reserveFraction: reserveFraction(hundredths / 100),
          });

          const spendable = budgetGate(
            weekly(allowance),
            week,
            [],
            TICKET,
            [],
          )?.spendable;

          assert.ok(
            spendable === undefined || Number.isSafeInteger(spendable),
            `${allowance} at ${hundredths / 100} left ${spendable} spendable`,
          );
        }
      }
    });

    it("lets a window through that has spent exactly what it may", () => {
      const week = noEstimateBudget({
        weeklyAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0.5),
      });

      assert.equal(budgetGate(weekly(500), week, [], TICKET, []), undefined);
      assert.equal(
        budgetGate(weekly(501), week, [], TICKET, [])?.reason,
        "weekly-reserve",
      );
    });

    it("holds nothing back at a reserve of 0", () => {
      const week = noEstimateBudget({
        weeklyAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0),
      });

      assert.equal(
        budgetGate(weekly(1_000), week, [], TICKET, []),
        undefined,
      );
      assert.equal(
        budgetGate(weekly(1_001), week, [], TICKET, [])?.reason,
        "weekly-reserve",
      );
    });

    it("reports what was spent against what was spendable", () => {
      const week = budget({
        weeklyAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0.5),
      });

      const standDown = budgetGate(weekly(900), week, [], TICKET, []);

      assert.equal(standDown?.tokensUsed, 900);
      assert.equal(standDown?.spendable, 500);
      assert.deepEqual(standDown?.resetsAt, NO_USAGE.weekly.resetsAt);
    });
  });

  describe("the 5-hour window", () => {
    function spentFiveHour(used: number): UsageWindows {
      return {
        ...NO_USAGE,
        fiveHour: { ...NO_USAGE.fiveHour, tokensUsed: tokenCount(used) },
      };
    }

    /**
     * The weekly reserve does not bleed into the 5-hour window: the block is
     * measured against its own allowance, less its own reserve — which a
     * machine declaring no `fiveHourReserveFraction` leaves at zero, so the
     * block is measured against its whole allowance, reserve or no weekly
     * reserve.
     */
    it("is measured against its own allowance, whatever the weekly reserve is", () => {
      const block = noEstimateBudget({
        fiveHourAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0.9),
      });

      assert.equal(
        budgetGate(spentFiveHour(1_000), block, [], TICKET, []),
        undefined,
      );
      assert.equal(
        budgetGate(spentFiveHour(1_001), block, [], TICKET, [])?.reason,
        "five-hour-window",
      );
    });

    /**
     * The 5-hour window shares `spendableOf` with the weekly one, but nothing
     * above pins that it rounds the reserve up the same way — see the
     * weekly window's own test above.
     */
    it("rounds a reserve that does not divide evenly the developer's way", () => {
      const block = noEstimateBudget({
        fiveHourAllowance: tokenCount(1_001),
        fiveHourReserveFraction: reserveFraction(0.5),
      });

      assert.equal(
        budgetGate(spentFiveHour(500), block, [], TICKET, []),
        undefined,
      );
      assert.equal(
        budgetGate(spentFiveHour(501), block, [], TICKET, [])?.spendable,
        500,
      );
    });

    it("lowers the 5-hour spendable at a non-zero fiveHourReserveFraction", () => {
      const block = noEstimateBudget({
        fiveHourAllowance: tokenCount(1_000),
        fiveHourReserveFraction: reserveFraction(0.1),
      });

      assert.equal(
        budgetGate(spentFiveHour(900), block, [], TICKET, []),
        undefined,
      );
      const refusal = budgetGate(spentFiveHour(901), block, [], TICKET, []);
      assert.equal(refusal?.reason, "five-hour-window");
      assert.equal(refusal?.spendable, 900);
    });
  });

  /**
   * The estimate arithmetic itself: charged on top of consumption against
   * both windows, told apart from a window already spent, and still a go
   * exactly on the boundary.
   */
  describe("charging the run estimate", () => {
    const SIZED_TICKET: Ticket = {
      ...TICKET,
      sizeLabel: { kind: "declared", size: "S" },
    };
    const ESTIMATE = DEFAULT_BUDGET.sizes.S;

    function budgetSpendable(spendable: number): Budget {
      return budget({
        weeklyAllowance: tokenCount(spendable),
        reserveFraction: reserveFraction(0),
      });
    }

    it("is a go when consumption plus the estimate lands exactly on spendable", () => {
      const week = budgetSpendable(ESTIMATE + 100);

      assert.equal(
        budgetGate(weekly(100), week, [], SIZED_TICKET, []),
        undefined,
      );
    });

    it("refuses one token past that boundary", () => {
      const week = budgetSpendable(ESTIMATE + 100);

      const refusal = budgetGate(weekly(101), week, [], SIZED_TICKET, []);

      assert.equal(refusal?.reason, "weekly-reserve-estimate");
      assert.equal(refusal?.tokensUsed, 101);
      assert.equal(refusal?.estimateCharged, ESTIMATE);
    });

    it("counts every ticket in progress toward the same window", () => {
      const inProgress: Ticket[] = [
        { ...TICKET, number: issueNumber(8), sizeLabel: { kind: "declared", size: "S" } },
        { ...TICKET, number: issueNumber(9), sizeLabel: { kind: "declared", size: "S" } },
      ];
      const week = budgetSpendable(ESTIMATE * 3);

      assert.equal(
        budgetGate(weekly(0), week, [], SIZED_TICKET, inProgress),
        undefined,
      );
      const refusal = budgetGate(
        weekly(1),
        week,
        [],
        SIZED_TICKET,
        inProgress,
      );
      assert.equal(refusal?.reason, "weekly-reserve-estimate");
      assert.equal(refusal?.estimateCharged, ESTIMATE * 3);
    });

    it("reports a window already over spendable as spent, not as the estimate", () => {
      const week = budgetSpendable(100);

      const refusal = budgetGate(weekly(101), week, [], SIZED_TICKET, []);

      assert.equal(refusal?.reason, "weekly-reserve");
      assert.equal(refusal?.estimateCharged, ESTIMATE);
    });

    it("charges the same total against the 5-hour window", () => {
      const block = budget({
        fiveHourAllowance: tokenCount(ESTIMATE + 100),
        fiveHourReserveFraction: reserveFraction(0),
      });
      const spentFiveHour = (used: number): UsageWindows => ({
        ...NO_USAGE,
        fiveHour: { ...NO_USAGE.fiveHour, tokensUsed: tokenCount(used) },
      });

      assert.equal(
        budgetGate(spentFiveHour(100), block, [], SIZED_TICKET, []),
        undefined,
      );
      assert.equal(
        budgetGate(spentFiveHour(101), block, [], SIZED_TICKET, [])?.reason,
        "five-hour-window-estimate",
      );
    });

    it("still names the later reset when one window is spent and the other only refuses on the estimate", () => {
      const bothWindows = budget({
        weeklyAllowance: tokenCount(100),
        reserveFraction: reserveFraction(0),
        fiveHourAllowance: tokenCount(ESTIMATE + 100),
        fiveHourReserveFraction: reserveFraction(0),
      });
      // The weekly window is spent outright; the 5-hour one is only pushed
      // over by the estimate. Its reset is pinned after the weekly one's, so
      // the tie-break has to reach past the spent window to find it — proving
      // an estimate-caused reason can win the tie-break, not only survive it.
      const windows: UsageWindows = {
        weekly: { ...NO_USAGE.weekly, tokensUsed: tokenCount(101) },
        fiveHour: {
          ...NO_USAGE.fiveHour,
          tokensUsed: tokenCount(101),
          resetsAt: new Date("2026-01-05T00:00:00.000Z"),
        },
      };

      const refusal = budgetGate(windows, bothWindows, [], SIZED_TICKET, []);

      assert.equal(refusal?.reason, "five-hour-window-estimate");
    });
  });
});

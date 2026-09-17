import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { budgetGate, invocationBudgetGate } from "./budget-gate.ts";
import {
  DEFAULT_BUDGET,
  issueNumber,
  recordRun,
  reserveFraction,
  tokenCount,
  type Budget,
  type ProjectState,
  type RepoSlug,
  type Ticket,
  type UsageWindows,
} from "./ports/index.ts";
import {
  FROZEN_NOW,
  LAST_WEEK,
  MANAGER,
  NO_USAGE,
  PILOT,
  YESTERDAY,
  FakeClock,
  FakeStore,
  FakeUsageLedger,
  spent,
} from "./testing/index.ts";

const TICKET: Ticket = { repo: PILOT, number: issueNumber(7), title: "Add the thing" };

/** The most a 500,000,000-token week may have spent before `DEFAULT_BUDGET`'s reserve refuses. */
const SPENDABLE_THIS_WEEK = 250_000_000;

/**
 * One invocation's gate, built the way `morningLoop` builds it: over the
 * state document's projects, read once up front and then held live — a run
 * `store.markWorked` after this call still reaches a later `consult`, the
 * same way a run `morningLoop` records mid-invocation does.
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
    const ledger = new FakeUsageLedger();
    ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK - 1 }));
    const gate = await openGate(store, ledger);

    assert.equal(await gate.consult(TICKET, []), undefined);
  });

  it("refuses rather than let the reserve be spent a token over", async () => {
    const store = new FakeStore();
    const ledger = new FakeUsageLedger();
    ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));
    const gate = await openGate(store, ledger);

    const refusal = await gate.consult(TICKET, []);

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

    const refusal = await gate.consult(TICKET, []);

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

    assert.equal((await gate.consult(TICKET, []))?.reason, "weekly-reserve");
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
      ...DEFAULT_BUDGET,
      weeklyAllowance: tokenCount(1_000),
      reserveFraction: reserveFraction(0.5),
    };
    const ledger = new FakeUsageLedger();
    ledger.reports(spent({ weekly: 600 }));
    const gate = await openGate(store, ledger);

    const before = await gate.consult(TICKET, []);
    store.budget = { ...store.budget, reserveFraction: reserveFraction(0) };
    const after = await gate.consult(TICKET, []);

    assert.equal(before?.reason, "weekly-reserve");
    assert.equal(after, undefined);
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

      assert.equal((await gate.consult(TICKET, []))?.reason, "weekly-reserve");
    });

    it("counts a run recorded against the live map after the gate was built", async () => {
      const store = new FakeStore();
      const ledger = new FakeUsageLedger();
      ledger.reports(spent({ weekly: 0 }));
      const state = await store.loadState();
      const projects = new Map(state.projects) as Map<RepoSlug, ProjectState>;
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

      assert.equal(before, undefined);
      assert.equal(after?.reason, "weekly-reserve");
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

      assert.equal((await gate.consult(TICKET, []))?.reason, "weekly-reserve");
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

      assert.equal(await gate.consult(TICKET, []), undefined);
    });
  });
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
      const week = budget({
        weeklyAllowance: tokenCount(1_001),
        reserveFraction: reserveFraction(0.5),
      });

      assert.equal(budgetGate(weekly(500), week, []), undefined);
      assert.equal(budgetGate(weekly(501), week, [])?.reason, "weekly-reserve");
      assert.equal(budgetGate(weekly(501), week, [])?.spendable, 500);
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

          const spendable = budgetGate(weekly(allowance), week, [])?.spendable;

          assert.ok(
            spendable === undefined || Number.isSafeInteger(spendable),
            `${allowance} at ${hundredths / 100} left ${spendable} spendable`,
          );
        }
      }
    });

    it("lets a window through that has spent exactly what it may", () => {
      const week = budget({
        weeklyAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0.5),
      });

      assert.equal(budgetGate(weekly(500), week, []), undefined);
      assert.equal(budgetGate(weekly(501), week, [])?.reason, "weekly-reserve");
    });

    it("holds nothing back at a reserve of 0", () => {
      const week = budget({
        weeklyAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0),
      });

      assert.equal(budgetGate(weekly(1_000), week, []), undefined);
      assert.equal(budgetGate(weekly(1_001), week, [])?.reason, "weekly-reserve");
    });

    it("reports what was spent against what was spendable", () => {
      const week = budget({
        weeklyAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0.5),
      });

      const standDown = budgetGate(weekly(900), week, []);

      assert.equal(standDown?.tokensUsed, 900);
      assert.equal(standDown?.spendable, 500);
      assert.deepEqual(standDown?.resetsAt, NO_USAGE.weekly.resetsAt);
    });
  });

  describe("the 5-hour window", () => {
    /**
     * The reserve is a share of the week (CONTEXT.md: Reserve), so the block
     * is measured against its allowance whole rather than against a share of
     * it: a spent block is a wall, not a supply to ration.
     */
    it("is measured against the whole allowance, reserve or no reserve", () => {
      const block = budget({
        fiveHourAllowance: tokenCount(1_000),
        reserveFraction: reserveFraction(0.9),
      });
      const spent = (used: number): UsageWindows => ({
        ...NO_USAGE,
        fiveHour: { ...NO_USAGE.fiveHour, tokensUsed: tokenCount(used) },
      });

      assert.equal(budgetGate(spent(1_000), block, []), undefined);
      assert.equal(budgetGate(spent(1_001), block, [])?.reason, "five-hour-window");
    });
  });
});

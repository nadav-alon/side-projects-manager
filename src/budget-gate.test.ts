import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { budgetGate } from "./budget-gate.ts";
import {
  DEFAULT_BUDGET,
  reserveFraction,
  tokenCount,
  type Budget,
  type UsageWindows,
} from "./ports/index.ts";
import { NO_USAGE } from "./testing/index.ts";

/**
 * The gate's behaviour is exercised through the loop seam in
 * `morning-run.test.ts`, per the spec's testing decisions. What is pinned here
 * is the arithmetic that seam cannot see the reason for: the reserve is held
 * back whole, and a reserve that quietly loses a token to floating point is
 * the one mistake the gate may not make.
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

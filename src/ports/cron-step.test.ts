import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cronStep, isCronStep } from "./cron-step.ts";

describe("isCronStep", () => {
  it("accepts every whole number from 1 to 30 that divides 60", () => {
    for (const value of ["1", "2", "3", "4", "5", "6", "10", "12", "15", "20", "30"]) {
      assert.ok(isCronStep(value), `expected to accept ${value}`);
    }
  });

  it("refuses a step that would space firings unevenly, or is not a whole step at all", () => {
    for (const value of ["", "0", "7", "25", "45", "60", "015", "-15", "*/15", "*", "0,30", "one"]) {
      assert.equal(isCronStep(value), false, `expected to refuse ${value}`);
    }
  });
});

describe("cronStep", () => {
  it("narrows a divisor of 60", () => {
    assert.equal(cronStep("15"), "15");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => cronStep("25"), /25/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cronMinute, isCronMinute } from "./cron-minute.ts";

describe("isCronMinute", () => {
  it("accepts every whole number from 0 to 59", () => {
    assert.ok(isCronMinute("0"));
    assert.ok(isCronMinute("9"));
    assert.ok(isCronMinute("30"));
    assert.ok(isCronMinute("59"));
  });

  it("refuses what a single cron field can be that is not one whole minute", () => {
    for (const value of ["", "*", "*/15", "0,30", "0-30", "60", "007", "-1", "one"]) {
      assert.equal(isCronMinute(value), false, `expected to refuse ${value}`);
    }
  });
});

describe("cronMinute", () => {
  it("narrows a whole number from 0 to 59", () => {
    assert.equal(cronMinute("0"), "0");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => cronMinute("*/15"), /\*\/15/);
  });
});

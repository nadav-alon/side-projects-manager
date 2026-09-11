import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock, FakeTriggerLock } from "./testing/index.ts";
import { runOncePerDay } from "./trigger-guard.ts";

describe("runOncePerDay", () => {
  it("invokes the first caller for a day", async () => {
    let invoked = 0;
    const ran = await runOncePerDay(new FakeTriggerLock(), new FakeClock(), async () => {
      invoked += 1;
    });

    assert.equal(ran, true);
    assert.equal(invoked, 1);
  });

  it("skips a second caller the same day, whichever trigger it is", async () => {
    const lock = new FakeTriggerLock();
    const clock = new FakeClock();
    let invoked = 0;
    const invoke = async () => {
      invoked += 1;
    };

    const first = await runOncePerDay(lock, clock, invoke);
    const second = await runOncePerDay(lock, clock, invoke);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(invoked, 1, "the loop fires exactly once");
  });

  it("invokes again once the calendar day changes", async () => {
    const lock = new FakeTriggerLock();
    let invoked = 0;
    const invoke = async () => {
      invoked += 1;
    };

    await runOncePerDay(lock, new FakeClock(new Date("2026-01-01T23:00:00")), invoke);
    const nextDay = await runOncePerDay(
      lock,
      new FakeClock(new Date("2026-01-02T01:00:00")),
      invoke,
    );

    assert.equal(nextDay, true);
    assert.equal(invoked, 2);
  });

  it("leaves the day claimed even when the invocation throws", async () => {
    const lock = new FakeTriggerLock();
    const clock = new FakeClock();

    await assert.rejects(
      runOncePerDay(lock, clock, async () => {
        throw new Error("the sandbox never came up");
      }),
    );

    let invoked = false;
    const second = await runOncePerDay(lock, clock, async () => {
      invoked = true;
    });

    assert.equal(second, false, "the failed run still claimed the day");
    assert.equal(invoked, false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withCheckoutLock } from "./checkout-lock.ts";
import { checkout } from "../ports/index.ts";
import { gate } from "../testing/index.ts";

const PILOT = checkout("/projects/pilot");
const OTHER = checkout("/projects/other");

/** Lets all work already able to start get as far as it can. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("withCheckoutLock", () => {
  it("never lets two pieces of work on one checkout overlap", async () => {
    const events: string[] = [];
    const work = (name: string) => async () => {
      events.push(`${name} enter`);
      await settle();
      events.push(`${name} leave`);
    };

    await Promise.all([
      withCheckoutLock(PILOT, work("a")),
      withCheckoutLock(PILOT, work("b")),
      withCheckoutLock(PILOT, work("c")),
    ]);

    assert.deepEqual(events, [
      "a enter",
      "a leave",
      "b enter",
      "b leave",
      "c enter",
      "c leave",
    ]);
  });

  it("lets work on different checkouts overlap", async () => {
    const pilot = gate();
    const events: string[] = [];

    const held = withCheckoutLock(PILOT, async () => {
      events.push("pilot enter");
      await pilot.opened;
      events.push("pilot leave");
    });
    await withCheckoutLock(OTHER, async () => {
      events.push("other");
    });
    pilot.open();
    await held;

    assert.deepEqual(events, ["pilot enter", "other", "pilot leave"]);
  });

  it("releases the checkout when work rejects", async () => {
    const failed = withCheckoutLock(PILOT, async () => {
      throw new Error("git refused");
    });
    const next = withCheckoutLock(PILOT, async () => "ran");

    await assert.rejects(failed, /git refused/);
    assert.equal(await next, "ran");
  });

  it("releases the checkout when work throws before it awaits anything", async () => {
    await assert.rejects(
      withCheckoutLock(PILOT, () => {
        throw new Error("git refused");
      }),
      /git refused/,
    );

    assert.equal(await withCheckoutLock(PILOT, async () => "ran"), "ran");
  });
});

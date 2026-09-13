import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withCheckoutLock } from "./checkout-lock.ts";
import { checkout } from "../ports/index.ts";

const PILOT = checkout("/projects/pilot");
const OTHER = checkout("/projects/other");

/** A promise, and the function that settles it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Lets every task already able to start get as far as it can. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("withCheckoutLock", () => {
  it("never lets two tasks on one checkout overlap", async () => {
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name} enter`);
      await settle();
      events.push(`${name} leave`);
    };

    await Promise.all([
      withCheckoutLock(PILOT, task("a")),
      withCheckoutLock(PILOT, task("b")),
      withCheckoutLock(PILOT, task("c")),
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

  it("lets tasks on different checkouts overlap", async () => {
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

  it("releases the checkout when a task rejects", async () => {
    const failed = withCheckoutLock(PILOT, async () => {
      throw new Error("git refused");
    });
    const next = withCheckoutLock(PILOT, async () => "ran");

    await assert.rejects(failed, /git refused/);
    assert.equal(await next, "ran");
  });

  it("releases the checkout when a task throws before it awaits anything", async () => {
    await assert.rejects(
      withCheckoutLock(PILOT, () => {
        throw new Error("git refused");
      }),
      /git refused/,
    );

    assert.equal(await withCheckoutLock(PILOT, async () => "ran"), "ran");
  });
});

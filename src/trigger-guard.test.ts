import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInvocationLease } from "./testing/index.ts";
import { invokeExclusively } from "./trigger-guard.ts";

describe("invokeExclusively", () => {
  it("invokes when the lease is acquired", async () => {
    let invoked = 0;
    const ran = await invokeExclusively(new FakeInvocationLease(), async () => {
      invoked += 1;
    });

    assert.equal(ran, true);
    assert.equal(invoked, 1);
  });

  it("skips when the lease is refused", async () => {
    const lease = new FakeInvocationLease();
    await lease.acquire();
    let invoked = 0;

    const ran = await invokeExclusively(lease, async () => {
      invoked += 1;
    });

    assert.equal(ran, false);
    assert.equal(invoked, 0);
  });

  it("releases the lease after the invocation", async () => {
    const lease = new FakeInvocationLease();

    await invokeExclusively(lease, async () => {});

    assert.equal(await lease.acquire(), true, "the lease is free again");
  });

  it("releases the lease even when the invocation throws", async () => {
    const lease = new FakeInvocationLease();

    await assert.rejects(
      invokeExclusively(lease, async () => {
        throw new Error("the sandbox never came up");
      }),
    );

    assert.equal(await lease.acquire(), true, "the lease is free again");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTicketPriority, ticketPriority } from "./ticket-priority.ts";

describe("isTicketPriority", () => {
  it("accepts 1, 2, and 3", () => {
    assert.equal(isTicketPriority(1), true);
    assert.equal(isTicketPriority(2), true);
    assert.equal(isTicketPriority(3), true);
  });

  it("rejects 0 and 4, since only three levels exist", () => {
    assert.equal(isTicketPriority(0), false);
    assert.equal(isTicketPriority(4), false);
  });

  it("rejects numbers that are not whole", () => {
    assert.equal(isTicketPriority(1.5), false);
    assert.equal(isTicketPriority(Number.NaN), false);
  });
});

describe("ticketPriority", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => ticketPriority(7), {
      name: "TypeError",
      message: /7/,
    });
  });
});

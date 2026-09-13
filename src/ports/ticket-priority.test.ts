import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTicketPriority, ticketPriority } from "./ticket-priority.ts";

describe("isTicketPriority", () => {
  it("accepts each of the three levels", () => {
    assert.equal(isTicketPriority(1), true);
    assert.equal(isTicketPriority(2), true);
    assert.equal(isTicketPriority(3), true);
  });

  it("rejects anything outside the three levels", () => {
    assert.equal(isTicketPriority(0), false);
    assert.equal(isTicketPriority(4), false);
    assert.equal(isTicketPriority(7), false);
    assert.equal(isTicketPriority(1.5), false);
    assert.equal(isTicketPriority(Number.NaN), false);
  });
});

describe("ticketPriority", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => ticketPriority(4), { name: "TypeError", message: /4/ });
  });
});

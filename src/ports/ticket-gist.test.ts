import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTicketGist, ticketGist } from "./ticket-gist.ts";

describe("isTicketGist", () => {
  it("accepts one non-empty line", () => {
    assert.equal(isTicketGist("Add retries to the flaky upload step."), true);
  });

  it("rejects an empty line", () => {
    assert.equal(isTicketGist(""), false);
  });

  it("rejects more than one line", () => {
    assert.equal(isTicketGist("First sentence.\nSecond sentence."), false);
  });
});

describe("ticketGist", () => {
  it("narrows a well-formed sentence", () => {
    assert.equal(
      ticketGist("Add retries to the flaky upload step."),
      "Add retries to the flaky upload step.",
    );
  });

  it("throws naming the offending value", () => {
    assert.throws(() => ticketGist(""), { name: "TypeError", message: /""/ });
  });
});

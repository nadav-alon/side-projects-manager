import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTicketGist, ticketGist } from "./ticket-gist.ts";

describe("isTicketGist", () => {
  it("accepts one non-empty, trimmed line", () => {
    assert.ok(isTicketGist("Adds a retry to the flaky upload step."));
  });

  it("refuses an empty gist", () => {
    assert.equal(isTicketGist(""), false);
  });

  it("refuses more than one line", () => {
    assert.equal(isTicketGist("First line.\nSecond line."), false);
  });

  it("refuses a gist carrying untrimmed whitespace", () => {
    assert.equal(isTicketGist("  Padded on both sides.  "), false);
  });
});

describe("ticketGist", () => {
  it("narrows a well-formed sentence", () => {
    assert.equal(ticketGist("Adds retries."), "Adds retries.");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => ticketGist("First.\nSecond."), /First\.\\nSecond\./);
  });
});

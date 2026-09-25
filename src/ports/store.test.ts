import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { issueNumber } from "./issue-number.ts";
import type { InvocationRecord, Journal, OpenInvocation } from "./journal.ts";
import { processId } from "./process-id.ts";
import { repoSlug } from "./repo-slug.ts";
import type { RunSpan } from "./store.ts";
import { recordRunSpanStarted, runSpanInProgress } from "./store.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const TICKET_7 = { repo: PILOT, number: issueNumber(7) };

const OPENER: OpenInvocation = {
  openedAt: new Date("2026-01-01T08:09:00.000Z"),
  process: processId(7563),
};

const SPAN: RunSpan = {
  ...TICKET_7,
  startedAt: new Date("2026-01-01T09:00:00.000Z"),
};

function journalOf(records: InvocationRecord[]): Journal {
  return { records };
}

describe("recordRunSpanStarted", () => {
  it("stamps the span with the invocation that opened it, when given one", () => {
    const spans = recordRunSpanStarted(undefined, TICKET_7, SPAN.startedAt, OPENER);

    assert.deepEqual(spans, [{ ...SPAN, openedBy: OPENER }]);
  });

  it("leaves the opening invocation off the span when none is given", () => {
    const spans = recordRunSpanStarted(undefined, TICKET_7, SPAN.startedAt);

    assert.deepEqual(spans, [SPAN]);
  });
});

describe("runSpanInProgress", () => {
  it("reads a span with its own endedAt as not in progress, whatever the journal says", () => {
    const span: RunSpan = { ...SPAN, endedAt: SPAN.startedAt, openedBy: OPENER };

    assert.equal(runSpanInProgress(span, OPENER, journalOf([{ ...OPENER }])), false);
  });

  it("reads a span naming no opening invocation as still in progress", () => {
    assert.equal(runSpanInProgress(SPAN, OPENER, journalOf([])), true);
  });

  it("reads a span whose opening invocation is self and still open on the journal as in progress", () => {
    const span: RunSpan = { ...SPAN, openedBy: OPENER };

    assert.equal(runSpanInProgress(span, OPENER, journalOf([{ ...OPENER }])), true);
  });

  it("reads a span whose opening invocation is still open on the journal but is not self as not in progress", () => {
    const span: RunSpan = { ...SPAN, openedBy: OPENER };
    const self: OpenInvocation = { ...OPENER, process: processId(1) };

    assert.equal(runSpanInProgress(span, self, journalOf([{ ...OPENER }])), false);
  });

  it("reads a span whose opening invocation has closed as not in progress", () => {
    const span: RunSpan = { ...SPAN, openedBy: OPENER };
    const closed: InvocationRecord = { ...OPENER, closedAt: new Date("2026-01-01T09:30:00.000Z") };

    assert.equal(runSpanInProgress(span, OPENER, journalOf([closed])), false);
  });

  it("reads a span whose opening invocation is missing from the journal as not in progress", () => {
    const span: RunSpan = { ...SPAN, openedBy: OPENER };

    assert.equal(runSpanInProgress(span, OPENER, journalOf([])), false);
  });
});

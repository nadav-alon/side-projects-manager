import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { grantSweep } from "./grant-sweep.ts";
import { day, issueNumber, repoSlug } from "./ports/index.ts";
import { fakeInvocationState, FakeIssueTracker, FakeStore } from "./testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const GRANTED_AT = new Date("2026-01-01T09:00:00.000Z");

async function arranged() {
  const store = new FakeStore();
  const tracker = new FakeIssueTracker();
  const open = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Open" });
  const closed = tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Closed" });
  store.markGranted(open, GRANTED_AT);
  store.markGranted(closed, GRANTED_AT);
  const { invocation } = fakeInvocationState({ store }, await store.loadState(), day("2026-01-01"));
  return { store, tracker, invocation, open, closed };
}

describe("grantSweep", () => {
  it("prunes the record of a closed ticket and keeps an open ticket's", async () => {
    const { store, tracker, invocation, open, closed } = await arranged();
    tracker.closeOutOfBand(closed);

    const pruned = await grantSweep(tracker, invocation);

    assert.deepEqual(pruned.map((grant) => grant.number), [closed.number]);
    assert.deepEqual(store.grants(), [{ repo: open.repo, number: open.number, grantedAt: GRANTED_AT }]);
  });

  it("keeps every record of a repo whose open issues were truncated", async () => {
    const { store, tracker, invocation, closed } = await arranged();
    tracker.closeOutOfBand(closed);
    tracker.truncateBacklog(PILOT);

    assert.deepEqual(await grantSweep(tracker, invocation), []);
    assert.equal(store.grants().length, 2);
  });

  it("keeps every record when the open issues cannot be read", async (t) => {
    const { store, tracker, invocation } = await arranged();
    t.mock.method(tracker, "listOpenIssues", async () => {
      throw new Error("offline");
    });
    t.mock.method(console, "warn", () => {});

    assert.deepEqual(await grantSweep(tracker, invocation), []);
    assert.equal(store.grants().length, 2);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { READY_FOR_HUMAN_LABEL, issueNumber, repoSlug } from "./ports/index.ts";
import type { IssueReference, RecordedDiscovery } from "./ports/index.ts";
import { recordedDiscoverySweep } from "./recorded-discovery-sweep.ts";
import { FakeIssueTracker, FakeStore } from "./testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const FILED_AT = new Date("2026-01-01T09:00:00.000Z");

function recorded(number: number, title = `Discovery on ${number}`): RecordedDiscovery {
  return { repo: PILOT, number: issueNumber(number), kind: "correction", title, filedAt: FILED_AT };
}

async function arranged() {
  const store = new FakeStore();
  const tracker = new FakeIssueTracker();
  const waiting = tracker.addIneligibleTicket(PILOT, { number: issueNumber(7), title: "Waiting" });
  const closed = tracker.addIneligibleTicket(PILOT, { number: issueNumber(8), title: "Closed" });
  const relabelled = tracker.addIneligibleTicket(PILOT, { number: issueNumber(9), title: "Handed on" });
  await store.recordDiscoveries([recorded(7), recorded(8), recorded(9), recorded(7, "Another on 7")]);
  return { store, tracker, waiting, closed, relabelled };
}

describe("recordedDiscoverySweep", () => {
  it("keeps the discoveries of a ticket that is open and ready-for-human", async () => {
    const { store, tracker } = await arranged();

    await recordedDiscoverySweep(tracker, store);

    assert.deepEqual(
      (await store.loadRecordedDiscoveries()).map(({ number }) => number),
      [7, 8, 9, 7],
    );
  });

  it("drops every discovery of a ticket that has closed", async () => {
    const { store, tracker, waiting, closed } = await arranged();
    tracker.closeOutOfBand(closed);
    tracker.closeOutOfBand(waiting);

    await recordedDiscoverySweep(tracker, store);

    assert.deepEqual((await store.loadRecordedDiscoveries()).map(({ number }) => number), [9]);
  });

  it("drops the discoveries of a ticket that no longer carries ready-for-human", async () => {
    const { store, tracker, relabelled } = await arranged();
    tracker.removeLabel(relabelled, READY_FOR_HUMAN_LABEL);

    await recordedDiscoverySweep(tracker, store);

    assert.deepEqual((await store.loadRecordedDiscoveries()).map(({ number }) => number), [7, 8, 7]);
  });

  it("keeps the discoveries of a ticket it cannot read, and still drops the others", async (t) => {
    const { store, tracker, closed } = await arranged();
    tracker.closeOutOfBand(closed);
    const read = tracker.isWaitingOnDeveloper.bind(tracker);
    t.mock.method(tracker, "isWaitingOnDeveloper", async (ticket: IssueReference) => {
      if (ticket.number === 7) {
        throw new Error("offline");
      }
      return read(ticket);
    });
    t.mock.method(console, "warn", () => {});

    await recordedDiscoverySweep(tracker, store);

    assert.deepEqual((await store.loadRecordedDiscoveries()).map(({ number }) => number), [7, 9, 7]);
  });

  it("does nothing, and never throws, when the recorded discoveries cannot be read", async (t) => {
    const { store, tracker } = await arranged();
    t.mock.method(store, "loadRecordedDiscoveries", async () => {
      throw new Error("unreadable");
    });
    t.mock.method(console, "warn", () => {});

    await recordedDiscoverySweep(tracker, store);

    t.mock.restoreAll();
    assert.equal((await store.loadRecordedDiscoveries()).length, 4);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dropDiscoveryOf } from "./drop-discovery.ts";
import { issueNumber, repoSlug } from "./ports/index.ts";
import type { RecordedDiscovery } from "./ports/index.ts";
import { FakeStore } from "./testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const FILED_AT = new Date("2026-01-01T09:00:00.000Z");

function recorded(number: number, title: string): RecordedDiscovery {
  return { repo: PILOT, number: issueNumber(number), kind: "correction", title, filedAt: FILED_AT };
}

describe("dropDiscoveryOf", () => {
  it("drops every discovery against the ticket, keeps the rest, and says how many", async () => {
    const store = new FakeStore();
    await store.recordDiscoveries([recorded(7, "One"), recorded(8, "Other"), recorded(7, "Two")]);

    const line = await dropDiscoveryOf(store, { repo: PILOT, number: issueNumber(7) });

    assert.equal(line, "Dropped 2 recorded discoveries on nadav-alon/pilot#7.");
    assert.deepEqual((await store.loadRecordedDiscoveries()).map(({ title }) => title), ["Other"]);
  });

  it("drops nothing for a ticket with no recorded discovery", async () => {
    const store = new FakeStore();
    await store.recordDiscoveries([recorded(8, "Other")]);

    const line = await dropDiscoveryOf(store, { repo: PILOT, number: issueNumber(7) });

    assert.equal(line, "Dropped 0 recorded discoveries on nadav-alon/pilot#7.");
    assert.equal((await store.loadRecordedDiscoveries()).length, 1);
  });
});

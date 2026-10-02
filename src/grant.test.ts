import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { grantTurboable, parseTicketReference } from "./grant.ts";
import { day, issueNumber, repoSlug, TURBOABLE_LABEL } from "./ports/index.ts";
import { FakeClock, FakeIssueTracker, FakeStore, FROZEN_NOW } from "./testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const TICKET = { repo: PILOT, number: issueNumber(7) };

describe("parseTicketReference", () => {
  it("reads owner/repo#n", () => {
    assert.deepEqual(parseTicketReference("nadav-alon/pilot#7"), TICKET);
  });

  for (const text of ["pilot#7", "nadav-alon/pilot", "nadav-alon/pilot#0", "nadav-alon/pilot#7x", "#7", ""]) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      assert.throws(() => parseTicketReference(text), /Not a ticket reference/);
    });
  }
});

describe("grantTurboable", () => {
  function arranged(registration?: { turbo: boolean }) {
    const store = new FakeStore();
    if (registration !== undefined) {
      store.register(PILOT, registration);
    }
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addIneligibleTicket(PILOT, { number: TICKET.number, title: "Grant me" });
    const labelled = () => tracker.carriesLabel(ticket, TURBOABLE_LABEL);
    return { store, tracker, labelled, ports: { store, clock: new FakeClock() } };
  }

  it("adds the label and writes a grant record stamped now", async () => {
    const { store, tracker, labelled, ports } = arranged({ turbo: true });

    await grantTurboable(ports, tracker, TICKET);

    assert.equal(labelled(), true);
    assert.deepEqual(store.grants(), [{ ...TICKET, grantedAt: FROZEN_NOW }]);
  });

  it("refuses a project whose turbo is off, labelling and writing nothing", async () => {
    const { store, tracker, labelled, ports } = arranged({ turbo: false });

    await assert.rejects(grantTurboable(ports, tracker, TICKET), /not a turbo project/);

    assert.equal(labelled(), false);
    assert.deepEqual(store.grants(), []);
  });

  it("refuses an unregistered project", async () => {
    const { store, tracker, labelled, ports } = arranged();

    await assert.rejects(grantTurboable(ports, tracker, TICKET), /not a registered project/);

    assert.equal(labelled(), false);
    assert.deepEqual(store.grants(), []);
  });

  it("writes no record when the label cannot be added", async () => {
    const { store, tracker, ports } = arranged({ turbo: true });
    tracker.labelTurboable = async () => {
      throw new Error("offline");
    };

    await assert.rejects(
      grantTurboable(ports, tracker, TICKET),
      /offline/,
    );

    assert.deepEqual(store.grants(), []);
  });

  it("keeps the state it found", async () => {
    const { store, tracker, ports } = arranged({ turbo: true });
    store.markAnnouncedOn(day("2026-01-01"));

    await grantTurboable(ports, tracker, TICKET);

    assert.equal((await store.loadState()).announcedOn, "2026-01-01");
  });
});

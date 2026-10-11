import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { grantLiveWrite, grantTurboable, parseGrantLabel, parseTicketReference } from "./grant.ts";
import { day, issueNumber, LIVE_WRITE_LABEL, repoSlug, TURBOABLE_LABEL } from "./ports/index.ts";
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
    tracker.labelGranted = async () => {
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

describe("parseGrantLabel", () => {
  it("reads the two labels a developer grants", () => {
    assert.equal(parseGrantLabel("turboable"), "turboable");
    assert.equal(parseGrantLabel("live-write"), "live-write");
  });

  it("refuses any other", () => {
    assert.throws(() => parseGrantLabel("ready-for-agent"), /Not a label to grant/);
  });
});

describe("grantLiveWrite", () => {
  function arranged(registration?: { turbo: boolean }) {
    const store = new FakeStore();
    if (registration !== undefined) {
      store.register(PILOT, registration);
    }
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addIneligibleTicket(PILOT, { number: TICKET.number, title: "Grant me" });
    return { store, tracker, ticket, ports: { store, clock: new FakeClock() } };
  }

  it("adds the live-write label and a live-write record stamped now, on a project without turbo", async () => {
    const { store, tracker, ticket, ports } = arranged({ turbo: false });

    await grantLiveWrite(ports, tracker, TICKET);

    assert.equal(tracker.carriesLabel(ticket, LIVE_WRITE_LABEL), true);
    assert.equal(tracker.carriesLabel(ticket, TURBOABLE_LABEL), false);
    assert.deepEqual(store.grants(), [{ ...TICKET, grantedAt: FROZEN_NOW, label: "live-write" }]);
  });

  it("refuses an unregistered project, labelling and writing nothing", async () => {
    const { store, tracker, ticket, ports } = arranged();

    await assert.rejects(grantLiveWrite(ports, tracker, TICKET), /not a registered project/);

    assert.equal(tracker.carriesLabel(ticket, LIVE_WRITE_LABEL), false);
    assert.deepEqual(store.grants(), []);
  });
});

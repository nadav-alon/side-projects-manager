import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { grantTurboable, parseTicketReference } from "./grant.ts";
import { issueNumber, repoSlug, TURBOABLE_LABEL } from "./ports/index.ts";
import { FakeClock, FakeStore, FROZEN_NOW } from "./testing/index.ts";

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
    const labelled: string[] = [];
    const addLabel = async (ticket: { repo: string; number: number }, label: string) => {
      labelled.push(`${ticket.repo}#${ticket.number} ${label}`);
    };
    return { store, labelled, addLabel, ports: { store, clock: new FakeClock() } };
  }

  it("adds the label and writes a grant record stamped now", async () => {
    const { store, labelled, addLabel, ports } = arranged({ turbo: true });

    await grantTurboable(ports, addLabel, TICKET);

    assert.deepEqual(labelled, [`nadav-alon/pilot#7 ${TURBOABLE_LABEL}`]);
    assert.deepEqual(store.grants(), [{ ...TICKET, grantedAt: FROZEN_NOW }]);
  });

  it("refuses a project whose turbo is off, labelling and writing nothing", async () => {
    const { store, labelled, addLabel, ports } = arranged({ turbo: false });

    await assert.rejects(grantTurboable(ports, addLabel, TICKET), /not a turbo project/);

    assert.deepEqual(labelled, []);
    assert.deepEqual(store.grants(), []);
  });

  it("refuses an unregistered project", async () => {
    const { store, labelled, addLabel, ports } = arranged();

    await assert.rejects(grantTurboable(ports, addLabel, TICKET), /not a registered project/);

    assert.deepEqual(labelled, []);
    assert.deepEqual(store.grants(), []);
  });

  it("writes no record when the label cannot be added", async () => {
    const { store, ports } = arranged({ turbo: true });

    await assert.rejects(
      grantTurboable(ports, async () => {
        throw new Error("offline");
      }, TICKET),
      /offline/,
    );

    assert.deepEqual(store.grants(), []);
  });

  it("keeps the state it found", async () => {
    const { store, addLabel, ports } = arranged({ turbo: true });
    store.markAnnouncedOn("2026-01-01" as never);

    await grantTurboable(ports, addLabel, TICKET);

    assert.equal((await store.loadState()).announcedOn, "2026-01-01");
  });
});

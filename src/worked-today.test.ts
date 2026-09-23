import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { workedTickets } from "./worked-today.ts";
import {
  day,
  issueNumber,
  processId,
  repoSlug,
  type InvocationRecord,
  type Journal,
  type OpenInvocation,
  type WorkedToday,
} from "./ports/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const TODAY = day("2026-09-19");
const TICKET = { repo: PILOT, number: issueNumber(432) };

const SELF: OpenInvocation = {
  openedAt: new Date("2026-09-19T09:56:00.000Z"),
  process: processId(9001),
};

const DEAD: OpenInvocation = {
  openedAt: new Date("2026-09-19T08:09:00.000Z"),
  process: processId(7563),
};

function storedWith(recordedBy?: OpenInvocation): WorkedToday {
  return {
    day: TODAY,
    tickets: [{ ...TICKET, ...(recordedBy !== undefined && { recordedBy }) }],
  };
}

function journalOf(records: InvocationRecord[]): Journal {
  return { records };
}

describe("workedTickets", () => {
  describe("freeing a dead invocation's entries", () => {
    it("frees a ticket recorded by an invocation still in flight when this one acquires the lease", () => {
      const stored = storedWith(DEAD);
      const journal = journalOf([{ ...DEAD }, { ...SELF }]);

      const worked = workedTickets(stored, TODAY, { self: SELF, journal });

      assert.equal(worked.passesOver(TICKET), false);
      assert.deepEqual(worked.workedToday(), { day: TODAY, tickets: [] });
      assert.deepEqual(worked.freed(), [
        { ticket: { ...TICKET, recordedBy: DEAD }, invocation: DEAD },
      ]);
    });

    it("does not free a ticket recorded by an invocation that closed", () => {
      const stored = storedWith(DEAD);
      const journal = journalOf([
        {
          ...DEAD,
          closedAt: new Date("2026-09-19T08:20:00.000Z"),
          outcome: "work-selected",
          projects: [],
        },
        { ...SELF },
      ]);

      const worked = workedTickets(stored, TODAY, { self: SELF, journal });

      assert.equal(worked.passesOver(TICKET), true);
      assert.deepEqual(worked.workedToday(), stored);
      assert.deepEqual(worked.freed(), []);
    });

    it("does not free a ticket recorded by the current invocation itself", () => {
      const stored = storedWith(SELF);
      const journal = journalOf([{ ...SELF }]);

      const worked = workedTickets(stored, TODAY, { self: SELF, journal });

      assert.equal(worked.passesOver(TICKET), true);
      assert.deepEqual(worked.freed(), []);
    });

    it("does not free a ticket whose invocation record is missing from the journal", () => {
      const stored = storedWith(DEAD);
      const journal = journalOf([{ ...SELF }]);

      const worked = workedTickets(stored, TODAY, { self: SELF, journal });

      assert.equal(worked.passesOver(TICKET), true);
      assert.deepEqual(worked.freed(), []);
    });

    it("reads a worked-today entry that names no invocation as today, not freed", () => {
      const stored = storedWith(undefined);
      const journal = journalOf([{ ...SELF }]);

      const worked = workedTickets(stored, TODAY, { self: SELF, journal });

      assert.equal(worked.passesOver(TICKET), true);
      assert.deepEqual(worked.freed(), []);
    });

    it("frees nothing when no current invocation identity is given", () => {
      const stored = storedWith(DEAD);

      const worked = workedTickets(stored, TODAY);

      assert.equal(worked.passesOver(TICKET), true);
      assert.deepEqual(worked.freed(), []);
    });

    it("still records a newly selected ticket against the current invocation's own identity", () => {
      const journal = journalOf([{ ...SELF }]);

      const worked = workedTickets(undefined, TODAY, { self: SELF, journal });
      worked.record({ repo: PILOT, number: issueNumber(500) }, TODAY);

      assert.deepEqual(worked.workedToday(), {
        day: TODAY,
        tickets: [{ repo: PILOT, number: issueNumber(500), recordedBy: SELF }],
      });
    });

    it("frees nothing, but still stamps a newly selected ticket with this invocation's identity, when the journal could not be read", () => {
      const stored = storedWith(DEAD);

      const worked = workedTickets(stored, TODAY, { self: SELF });
      worked.record({ repo: PILOT, number: issueNumber(500) }, TODAY);

      assert.equal(worked.passesOver(TICKET), true);
      assert.deepEqual(worked.freed(), []);
      assert.deepEqual(worked.workedToday(), {
        day: TODAY,
        tickets: [
          { ...TICKET, recordedBy: DEAD },
          { repo: PILOT, number: issueNumber(500), recordedBy: SELF },
        ],
      });
    });
  });
});

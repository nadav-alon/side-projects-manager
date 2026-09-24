import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  invocationState,
  invocationStateRest,
  recordWorkedForTest,
} from "./invocation-state.ts";
import type { Iteration } from "./iteration-outcome.ts";
import {
  branch,
  day,
  issueNumber,
  processId,
  repoSlug,
  tokenCount,
  type InvocationRecord,
  type Journal,
  type OpenInvocation,
  type State,
  type WorkedTicket,
  type WorkedToday,
} from "./ports/index.ts";
import { FakeStore } from "./testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const MANAGER = repoSlug("nadav-alon/side-projects-manager");
const TODAY = day("2026-01-01");
const YESTERDAY = day("2025-12-31");

const TICKET_7: WorkedTicket = { repo: PILOT, number: issueNumber(7) };
const TICKET_8: WorkedTicket = { repo: PILOT, number: issueNumber(8) };

const EMPTY_STATE: State = { projects: new Map() };

const SELF: OpenInvocation = {
  openedAt: new Date("2026-01-01T09:56:00.000Z"),
  process: processId(9001),
};

const DEAD: OpenInvocation = {
  openedAt: new Date("2026-01-01T08:09:00.000Z"),
  process: processId(7563),
};

/** The supplier for a test that never cares about `announcedOn` or `salvages`. */
const noForeignFields = () => ({});

/** A state document holding `TICKET_7` worked today, recorded by `recordedBy`. */
function storedWith(recordedBy?: OpenInvocation): State {
  const workedToday: WorkedToday = {
    day: TODAY,
    tickets: [{ ...TICKET_7, ...(recordedBy !== undefined && { recordedBy }) }],
  };
  return { projects: new Map(), workedToday };
}

function journalOf(records: InvocationRecord[]): Journal {
  return { records };
}

describe("invocationState", () => {
  describe("passesOver", () => {
    it("passes over a ticket the state document already recorded today", async () => {
      const store = new FakeStore();
      store.markWorkedOn(TODAY, TICKET_7);
      const invocation = invocationState({ store }, await store.loadState(), TODAY, noForeignFields);

      assert.equal(invocation.passesOver(TICKET_7), true);
    });

    it("reads a record for any other day as nothing worked yet", async () => {
      const store = new FakeStore();
      store.markWorkedOn(YESTERDAY, TICKET_7);
      const invocation = invocationState({ store }, await store.loadState(), TODAY, noForeignFields);

      assert.equal(invocation.passesOver(TICKET_7), false);
    });

    it("keeps passing a ticket over for the rest of the invocation once it is taken back off the record", () => {
      const invocation = invocationState({ store: new FakeStore() }, EMPTY_STATE, TODAY, noForeignFields);

      recordWorkedForTest(invocation, TICKET_7, TODAY);
      invocation.selectionAbandoned(TICKET_7);

      assert.equal(invocation.passesOver(TICKET_7), true);
    });
  });

  describe("ticketSelected", () => {
    it("saves the record before it resolves, so a ticket counts as worked before the sandbox starts", async () => {
      const store = new FakeStore();
      const invocation = invocationState({ store }, await store.loadState(), TODAY, noForeignFields);

      await invocation.ticketSelected(TICKET_7, TODAY);

      assert.deepEqual((await store.loadState()).workedToday, {
        day: TODAY,
        tickets: [TICKET_7],
      });
    });

    it("takes the ticket back off the record when the save itself fails, and still lets the failure reach the caller", async (t) => {
      const store = new FakeStore();
      const invocation = invocationState({ store }, EMPTY_STATE, TODAY, noForeignFields);
      const saveState = t.mock.method(store, "saveState", async () => {
        throw new Error("disk full");
      });

      await assert.rejects(
        invocation.ticketSelected(TICKET_7, TODAY),
        /disk full/,
      );

      saveState.mock.restore();
      await invocation.save();

      assert.deepEqual((await store.loadState()).workedToday?.tickets, []);
    });
  });

  describe("recordRunCost and projectStates", () => {
    it("records a finished run's cost against its project, read live by the budget gate's own view", () => {
      const invocation = invocationState({ store: new FakeStore() }, EMPTY_STATE, TODAY, noForeignFields);
      const at = new Date("2026-01-01T09:00:00.000Z");

      invocation.recordRunCost(PILOT, { at, tokensUsed: tokenCount(120_000) });

      assert.deepEqual(invocation.projectStates().get(PILOT), {
        lastWorkedAt: at,
        runs: [{ at, tokensUsed: tokenCount(120_000) }],
      });
    });

    it("appends to a project's earlier runs rather than replacing them", async () => {
      const store = new FakeStore();
      store.markWorked(PILOT, new Date("2025-12-31T09:00:00.000Z"), {
        at: new Date("2025-12-31T09:00:00.000Z"),
        tokensUsed: tokenCount(50_000),
      });
      const stored = await store.loadState();
      const invocation = invocationState({ store }, stored, TODAY, noForeignFields);
      const at = new Date("2026-01-01T09:00:00.000Z");

      invocation.recordRunCost(PILOT, { at, tokensUsed: tokenCount(70_000) });

      assert.equal(invocation.projectStates().get(PILOT)?.runs.length, 2);
    });
  });

  describe("iterationEnded", () => {
    it("frees a ticket a cut-off run says nothing about", async () => {
      const store = new FakeStore();
      const invocation = invocationState({ store }, EMPTY_STATE, TODAY, noForeignFields);
      recordWorkedForTest(invocation, TICKET_7, TODAY);
      const iteration: Iteration = {
        kind: "provider-failed",
        providerFailure: "the provider is down",
        tokensUsed: tokenCount(0),
        discard: { kind: "none" },
      };

      invocation.iterationEnded(TICKET_7, iteration);
      await invocation.save();

      assert.deepEqual((await store.loadState()).workedToday?.tickets, []);
    });

    it("leaves a pull request ticket recorded when its own close failed", async () => {
      const store = new FakeStore();
      const invocation = invocationState({ store }, EMPTY_STATE, TODAY, noForeignFields);
      await invocation.ticketSelected(TICKET_7, TODAY);
      const iteration: Iteration = {
        kind: "pull-request-resolved",
        resolution: "merged",
        notClosed: { kind: "close-failed", error: "the tracker refused" },
      };

      invocation.iterationEnded(TICKET_7, iteration);
      await invocation.save();

      assert.deepEqual((await store.loadState()).workedToday, {
        day: TODAY,
        tickets: [TICKET_7],
      });
    });

    it("frees a pull request ticket once it closed cleanly", async () => {
      const store = new FakeStore();
      const invocation = invocationState({ store }, EMPTY_STATE, TODAY, noForeignFields);
      await invocation.ticketSelected(TICKET_7, TODAY);
      const iteration: Iteration = {
        kind: "pull-request-resolved",
        resolution: "merged",
      };

      invocation.iterationEnded(TICKET_7, iteration);
      await invocation.save();

      assert.deepEqual((await store.loadState()).workedToday?.tickets, []);
    });
  });

  describe("save", () => {
    it("folds announcedOn and the salvage record in, alongside its own bookkeeping", async () => {
      const store = new FakeStore();
      const salvage = [{ ...TICKET_8, branch: branch("issue-8-salvaged"), stopShorts: 1 }];
      const invocation = invocationState({ store }, EMPTY_STATE, TODAY, () =>
        invocationStateRest(TODAY, salvage),
      );
      recordWorkedForTest(invocation, TICKET_7, TODAY);
      invocation.recordRunCost(PILOT, {
        at: new Date("2026-01-01T09:00:00.000Z"),
        tokensUsed: tokenCount(10_000),
      });

      await invocation.save();

      const saved = await store.loadState();
      assert.deepEqual(saved.workedToday, { day: TODAY, tickets: [TICKET_7] });
      assert.equal(saved.announcedOn, TODAY);
      assert.deepEqual(saved.salvages, salvage);
      assert.equal(saved.projects.get(PILOT)?.runs.length, 1);
    });

    it("leaves announcedOn and salvages out of the document when rest names none", async () => {
      const store = new FakeStore();
      const invocation = invocationState({ store }, EMPTY_STATE, TODAY, noForeignFields);

      await invocation.save();

      const saved = await store.loadState();
      assert.equal(saved.announcedOn, undefined);
      assert.equal(saved.salvages, undefined);
    });

    it("keeps two interleaved iterations' records and run costs, both surviving the final save", async () => {
      const store = new FakeStore();
      const invocation = invocationState({ store }, EMPTY_STATE, TODAY, noForeignFields);

      // Two iterations "in progress" at once, per the concurrency limit:
      // both are selected before either's own save has landed, exactly as
      // two overlapping calls from a concurrency-limited loop would arrive.
      const firstSelected = invocation.ticketSelected(TICKET_7, TODAY);
      const secondSelected = invocation.ticketSelected(TICKET_8, TODAY);
      await Promise.all([firstSelected, secondSelected]);
      // The first iteration ends and records its run's cost; the second is
      // still going when the invocation's own final save happens.
      invocation.recordRunCost(PILOT, {
        at: new Date("2026-01-01T09:00:00.000Z"),
        tokensUsed: tokenCount(200_000),
      });
      invocation.iterationEnded(TICKET_7, {
        kind: "pull-request-resolved",
        resolution: "merged",
      });
      invocation.recordRunCost(MANAGER, {
        at: new Date("2026-01-01T09:05:00.000Z"),
        tokensUsed: tokenCount(300_000),
      });

      await invocation.save();

      const saved = await store.loadState();
      assert.deepEqual(saved.workedToday, { day: TODAY, tickets: [TICKET_8] });
      assert.equal(saved.projects.get(PILOT)?.runs[0]?.tokensUsed, 200_000);
      assert.equal(saved.projects.get(MANAGER)?.runs[0]?.tokensUsed, 300_000);
    });
  });

  describe("freeing a dead invocation's entries", () => {
    it("frees a ticket recorded by an invocation still in flight when this one acquires the lease", () => {
      const journal = journalOf([{ ...DEAD }, { ...SELF }]);

      const state = invocationState({ store: new FakeStore() }, storedWith(DEAD), TODAY, noForeignFields, {
        self: SELF,
        journal,
      });

      assert.equal(state.passesOver(TICKET_7), false);
      assert.deepEqual(state.freed(), [
        { ticket: { ...TICKET_7, recordedBy: DEAD }, invocation: DEAD },
      ]);
    });

    it("saves the freed entry off the record, so a later firing today may select it", async () => {
      const store = new FakeStore();
      const journal = journalOf([{ ...DEAD }, { ...SELF }]);

      const state = invocationState({ store }, storedWith(DEAD), TODAY, noForeignFields, {
        self: SELF,
        journal,
      });
      await state.save();

      assert.deepEqual((await store.loadState()).workedToday, { day: TODAY, tickets: [] });
    });

    it("does not free a ticket recorded by an invocation that closed", () => {
      const journal = journalOf([
        {
          ...DEAD,
          closedAt: new Date("2026-01-01T08:20:00.000Z"),
          outcome: "work-selected",
          projects: [],
        },
        { ...SELF },
      ]);

      const state = invocationState({ store: new FakeStore() }, storedWith(DEAD), TODAY, noForeignFields, {
        self: SELF,
        journal,
      });

      assert.equal(state.passesOver(TICKET_7), true);
      assert.deepEqual(state.freed(), []);
    });

    it("does not free a ticket recorded by the current invocation itself", () => {
      const journal = journalOf([{ ...SELF }]);

      const state = invocationState({ store: new FakeStore() }, storedWith(SELF), TODAY, noForeignFields, {
        self: SELF,
        journal,
      });

      assert.equal(state.passesOver(TICKET_7), true);
      assert.deepEqual(state.freed(), []);
    });

    it("does not free a ticket whose invocation record is missing from the journal", () => {
      const journal = journalOf([{ ...SELF }]);

      const state = invocationState({ store: new FakeStore() }, storedWith(DEAD), TODAY, noForeignFields, {
        self: SELF,
        journal,
      });

      assert.equal(state.passesOver(TICKET_7), true);
      assert.deepEqual(state.freed(), []);
    });

    it("reads a worked-today entry that names no invocation as today, not freed", () => {
      const journal = journalOf([{ ...SELF }]);

      const state = invocationState({ store: new FakeStore() }, storedWith(undefined), TODAY, noForeignFields, {
        self: SELF,
        journal,
      });

      assert.equal(state.passesOver(TICKET_7), true);
      assert.deepEqual(state.freed(), []);
    });

    it("frees nothing when no current invocation identity is given", () => {
      const state = invocationState({ store: new FakeStore() }, storedWith(DEAD), TODAY, noForeignFields);

      assert.equal(state.passesOver(TICKET_7), true);
      assert.deepEqual(state.freed(), []);
    });

    it("stamps a newly selected ticket with the current invocation's own identity", async () => {
      const store = new FakeStore();
      const journal = journalOf([{ ...SELF }]);

      const state = invocationState({ store }, EMPTY_STATE, TODAY, noForeignFields, {
        self: SELF,
        journal,
      });
      await state.ticketSelected(TICKET_8, TODAY);

      assert.deepEqual((await store.loadState()).workedToday, {
        day: TODAY,
        tickets: [{ ...TICKET_8, recordedBy: SELF }],
      });
    });

    it("frees nothing, but still stamps a newly selected ticket, when the journal could not be read", async () => {
      const store = new FakeStore();

      const state = invocationState({ store }, storedWith(DEAD), TODAY, noForeignFields, { self: SELF });
      await state.ticketSelected(TICKET_8, TODAY);

      assert.equal(state.passesOver(TICKET_7), true);
      assert.deepEqual(state.freed(), []);
      assert.deepEqual((await store.loadState()).workedToday, {
        day: TODAY,
        tickets: [
          { ...TICKET_7, recordedBy: DEAD },
          { ...TICKET_8, recordedBy: SELF },
        ],
      });
    });
  });
});

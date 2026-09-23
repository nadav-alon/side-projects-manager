import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stateSession, stateSessionRest } from "./state-session.ts";
import type { Iteration } from "./iteration-outcome.ts";
import {
  branch,
  day,
  issueNumber,
  repoSlug,
  tokenCount,
  type State,
  type WorkedTicket,
} from "./ports/index.ts";
import { FakeStore } from "./testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const MANAGER = repoSlug("nadav-alon/side-projects-manager");
const TODAY = day("2026-01-01");
const YESTERDAY = day("2025-12-31");

const TICKET_7: WorkedTicket = { repo: PILOT, number: issueNumber(7) };
const TICKET_8: WorkedTicket = { repo: PILOT, number: issueNumber(8) };

const EMPTY_STATE: State = { projects: new Map() };

/**
 * A store whose `saveState` can be told to fail on command — for pinning
 * `ticketSelected`'s own rollback, which `FakeStore` alone cannot arrange
 * since it never fails.
 */
class FlakyStore {
  saved: State[] = [];
  fails = false;

  async saveState(state: State): Promise<void> {
    if (this.fails) {
      throw new Error("disk full");
    }
    this.saved.push(state);
  }
}

describe("stateSession", () => {
  describe("passesOver", () => {
    it("passes over a ticket the state document already recorded today", async () => {
      const store = new FakeStore();
      store.markWorkedOn(TODAY, TICKET_7);
      const session = stateSession({ store }, await store.loadState(), TODAY);

      assert.equal(session.passesOver(TICKET_7), true);
    });

    it("reads a record for any other day as nothing worked yet", async () => {
      const store = new FakeStore();
      store.markWorkedOn(YESTERDAY, TICKET_7);
      const session = stateSession({ store }, await store.loadState(), TODAY);

      assert.equal(session.passesOver(TICKET_7), false);
    });

    it("keeps passing a ticket over for the rest of the invocation once it is taken back off the record", () => {
      const session = stateSession({ store: new FakeStore() }, EMPTY_STATE, TODAY);

      session.recordWorked(TICKET_7, TODAY);
      session.unrecordWorked(TICKET_7);

      assert.equal(session.passesOver(TICKET_7), true);
    });
  });

  describe("ticketSelected", () => {
    it("saves the record before it resolves, so a ticket counts as worked before the sandbox starts", async () => {
      const store = new FakeStore();
      const session = stateSession({ store }, await store.loadState(), TODAY);

      await session.ticketSelected(TICKET_7, TODAY);

      assert.deepEqual((await store.loadState()).workedToday, {
        day: TODAY,
        tickets: [TICKET_7],
      });
    });

    it("takes the ticket back off the record when the save itself fails, and still lets the failure reach the caller", async () => {
      const store = new FlakyStore();
      const session = stateSession({ store }, EMPTY_STATE, TODAY);
      store.fails = true;

      await assert.rejects(
        session.ticketSelected(TICKET_7, TODAY),
        /disk full/,
      );

      store.fails = false;
      await session.save();

      assert.deepEqual(store.saved.at(-1)?.workedToday?.tickets, []);
    });
  });

  describe("recordRunCost and projectStates", () => {
    it("records a finished run's cost against its project, read live by the budget gate's own view", () => {
      const session = stateSession({ store: new FakeStore() }, EMPTY_STATE, TODAY);
      const at = new Date("2026-01-01T09:00:00.000Z");

      session.recordRunCost(PILOT, { at, tokensUsed: tokenCount(120_000) });

      assert.deepEqual(session.projectStates().get(PILOT), {
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
      const session = stateSession({ store }, stored, TODAY);
      const at = new Date("2026-01-01T09:00:00.000Z");

      session.recordRunCost(PILOT, { at, tokensUsed: tokenCount(70_000) });

      assert.equal(session.projectStates().get(PILOT)?.runs.length, 2);
    });
  });

  describe("iterationEnded", () => {
    it("frees a ticket a cut-off run says nothing about", async () => {
      const store = new FakeStore();
      const session = stateSession({ store }, EMPTY_STATE, TODAY);
      session.recordWorked(TICKET_7, TODAY);
      const iteration: Iteration = {
        kind: "provider-failed",
        providerFailure: "the provider is down",
        tokensUsed: tokenCount(0),
        discard: { kind: "none" },
      };

      session.iterationEnded(TICKET_7, iteration);
      await session.save();

      assert.deepEqual((await store.loadState()).workedToday?.tickets, []);
    });

    it("leaves a pull request ticket recorded when its own close failed", async () => {
      const store = new FakeStore();
      const session = stateSession({ store }, EMPTY_STATE, TODAY);
      await session.ticketSelected(TICKET_7, TODAY);
      const iteration: Iteration = {
        kind: "pull-request-resolved",
        resolution: "merged",
        notClosed: { kind: "close-failed", error: "the tracker refused" },
      };

      session.iterationEnded(TICKET_7, iteration);
      await session.save();

      assert.deepEqual((await store.loadState()).workedToday, {
        day: TODAY,
        tickets: [TICKET_7],
      });
    });

    it("frees a pull request ticket once it closed cleanly", async () => {
      const store = new FakeStore();
      const session = stateSession({ store }, EMPTY_STATE, TODAY);
      await session.ticketSelected(TICKET_7, TODAY);
      const iteration: Iteration = {
        kind: "pull-request-resolved",
        resolution: "merged",
      };

      session.iterationEnded(TICKET_7, iteration);
      await session.save();

      assert.deepEqual((await store.loadState()).workedToday?.tickets, []);
    });
  });

  describe("save", () => {
    it("folds announcedOn and the salvage record in, alongside its own bookkeeping", async () => {
      const store = new FakeStore();
      const session = stateSession({ store }, EMPTY_STATE, TODAY);
      session.recordWorked(TICKET_7, TODAY);
      session.recordRunCost(PILOT, {
        at: new Date("2026-01-01T09:00:00.000Z"),
        tokensUsed: tokenCount(10_000),
      });
      const salvage = [{ ...TICKET_8, branch: branch("issue-8-salvaged"), stopShorts: 1 }];

      await session.save(stateSessionRest(TODAY, salvage));

      const saved = await store.loadState();
      assert.deepEqual(saved.workedToday, { day: TODAY, tickets: [TICKET_7] });
      assert.equal(saved.announcedOn, TODAY);
      assert.deepEqual(saved.salvages, salvage);
      assert.equal(saved.projects.get(PILOT)?.runs.length, 1);
    });

    it("leaves announcedOn and salvages out of the document when rest names none", async () => {
      const store = new FakeStore();
      const session = stateSession({ store }, EMPTY_STATE, TODAY);

      await session.save();

      const saved = await store.loadState();
      assert.equal(saved.announcedOn, undefined);
      assert.equal(saved.salvages, undefined);
    });

    it("keeps two interleaved iterations' records and run costs, both surviving the final save", async () => {
      const store = new FakeStore();
      const session = stateSession({ store }, EMPTY_STATE, TODAY);

      // Two iterations "in progress" at once, per the concurrency limit:
      // both are selected before either ends.
      await session.ticketSelected(TICKET_7, TODAY);
      await session.ticketSelected(TICKET_8, TODAY);
      // The first iteration ends and records its run's cost; the second is
      // still going when the invocation's own final save happens.
      session.recordRunCost(PILOT, {
        at: new Date("2026-01-01T09:00:00.000Z"),
        tokensUsed: tokenCount(200_000),
      });
      session.iterationEnded(TICKET_7, {
        kind: "pull-request-resolved",
        resolution: "merged",
      });
      session.recordRunCost(MANAGER, {
        at: new Date("2026-01-01T09:05:00.000Z"),
        tokensUsed: tokenCount(300_000),
      });

      await session.save();

      const saved = await store.loadState();
      assert.deepEqual(saved.workedToday, { day: TODAY, tickets: [TICKET_8] });
      assert.equal(saved.projects.get(PILOT)?.runs[0]?.tokensUsed, 200_000);
      assert.equal(saved.projects.get(MANAGER)?.runs[0]?.tokensUsed, 300_000);
    });
  });
});

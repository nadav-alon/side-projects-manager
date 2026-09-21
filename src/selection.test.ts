import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  invocationSelection,
  type InvocationSelection,
  type Selection,
} from "./selection.ts";
import { workedTickets, type WorkedTickets } from "./worked-today.ts";
import {
  issueNumber,
  localDay,
  NEEDS_REBASE,
  priority,
  pullRequestUrl,
  REBASE_COMMENT,
  reviewTitle,
  ticketPriority,
  type Day,
  type Ticket,
} from "./ports/index.ts";
import {
  FROZEN_NOW,
  LAST_WEEK,
  MANAGER,
  PILOT,
  YESTERDAY,
  FakeIssueTracker,
  FakeRepoHost,
  FakeStore,
  verdicts,
} from "./testing/index.ts";

const TODAY = localDay(FROZEN_NOW);

/**
 * One invocation's selection, built the way `morningLoop` builds it: from the
 * state document's projects and worked-today record, both read once up
 * front and then held for the life of the invocation.
 */
async function open(
  store: FakeStore,
  tracker: FakeIssueTracker,
  { today = TODAY, repoHost = new FakeRepoHost() }: {
    today?: Day;
    repoHost?: FakeRepoHost;
  } = {},
): Promise<{ selection: InvocationSelection; worked: WorkedTickets }> {
  const state = await store.loadState();
  const worked = workedTickets(state.workedToday, today);
  return {
    selection: invocationSelection(
      { tracker, store, repoHost },
      new Map(state.projects),
      worked,
    ),
    worked,
  };
}

/**
 * Calls `next` until nothing is left to select, recording each selection as
 * worked before asking again — exactly what an invocation whose every
 * iteration finishes cleanly does between one scan and the next.
 */
async function drain(
  selection: InvocationSelection,
  worked: WorkedTickets,
  today: Day = TODAY,
): Promise<Selection[]> {
  const selections: Selection[] = [];
  for (;;) {
    const chosen = await selection.next();
    if (chosen === undefined) {
      return selections;
    }
    selections.push(chosen);
    worked.record(chosen.ticket, today);
  }
}

describe("invocationSelection", () => {
  it("selects nothing when no project is registered", async () => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    const { selection } = await open(store, tracker);

    assert.equal(await selection.next(), undefined);
    assert.deepEqual(selection.verdicts(), []);
  });

  it("reads a project with an empty backlog as having no eligible tickets", async () => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    store.register(MANAGER);
    store.register(PILOT);
    const { selection } = await open(store, tracker);

    assert.equal(await selection.next(), undefined);
    assert.deepEqual(verdicts(selection.verdicts()), [
      [MANAGER, "no-eligible-tickets"],
      [PILOT, "no-eligible-tickets"],
    ]);
  });

  it("asks the tracker about every registered project", async (t) => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    store.register(MANAGER);
    store.register(PILOT);
    const listOpenIssues = t.mock.method(tracker, "listOpenIssues");
    const { selection } = await open(store, tracker);

    await selection.next();

    assert.equal(listOpenIssues.mock.callCount(), 2);
    assert.deepEqual(
      listOpenIssues.mock.calls.map((call) => call.arguments[0]),
      [MANAGER, PILOT],
    );
  });

  it("selects the project it found work in", async () => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    store.register(PILOT);
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const { selection } = await open(store, tracker);

    const chosen = await selection.next();

    assert.equal(chosen?.project.repo, PILOT);
    assert.equal(chosen?.ticket.number, 7);
    assert.deepEqual(verdicts(selection.verdicts()), [[PILOT, "selected"]]);
  });

  it("asks every non-paused project again on the next scan, since priority can still send the mornings elsewhere", async (t) => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    store.register(PILOT);
    store.register(MANAGER);
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const listOpenIssues = t.mock.method(tracker, "listOpenIssues");
    const { selection, worked } = await open(store, tracker);

    const first = await selection.next();
    worked.record(first!.ticket, TODAY);
    await selection.next();

    // Twice each: once to select PILOT's one ticket, and again once it is
    // worked, to confirm nothing else — MANAGER included — was left waiting.
    assert.deepEqual(
      listOpenIssues.mock.calls.map((call) => call.arguments[0]),
      [PILOT, MANAGER, PILOT, MANAGER],
    );
  });

  it("sees a project registered after the invocation began", async () => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    store.register(PILOT);
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const { selection, worked } = await open(store, tracker);

    const first = await selection.next();
    worked.record(first!.ticket, TODAY);
    // Registered only after the first scan, as the developer hand-editing
    // the registry mid-morning would leave it.
    store.register(MANAGER);
    await selection.next();

    assert.deepEqual(verdicts(selection.verdicts()), [
      [PILOT, "selected"],
      [MANAGER, "no-eligible-tickets"],
    ]);
  });

  it("selects one project and one ticket per scan, working through a backlog one at a time", async () => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    store.register(PILOT);
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addEligibleTicket(PILOT, {
      number: issueNumber(8),
      title: "Add the other thing",
    });
    const { selection, worked } = await open(store, tracker);

    const selections = await drain(selection, worked);

    // Two distinct tickets, one per scan: the second scan picked up what the
    // first left, since ticket #7 is excluded once worked rather than
    // re-offered.
    assert.deepEqual(
      selections.map((selected) => selected.ticket.number),
      [7, 8],
    );
  });

  it("keeps a project's selected verdict once a later scan finds nothing left of its backlog", async () => {
    const store = new FakeStore();
    const tracker = new FakeIssueTracker();
    store.register(PILOT);
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const { selection, worked } = await open(store, tracker);

    const first = await selection.next();
    worked.record(first!.ticket, TODAY);
    // A second scan of the same backlog finds nothing left to select — the
    // sticky verdict from the first scan is what must survive it.
    const second = await selection.next();

    assert.equal(second, undefined);
    assert.deepEqual(verdicts(selection.verdicts()), [[PILOT, "selected"]]);
  });

  describe("a paused project", () => {
    it("is never considered, however much work it has", async (t) => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT, { paused: true });
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const listOpenIssues = t.mock.method(tracker, "listOpenIssues");
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(listOpenIssues.mock.callCount(), 0);
      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [[PILOT, "paused"]]);
    });

    it("does not stop the projects behind it being worked", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER, { paused: true });
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const { selection, worked } = await open(store, tracker);

      const selections = await drain(selection, worked);

      assert.deepEqual(
        selections.map((selected) => selected.project.repo),
        [PILOT],
      );
      assert.deepEqual(verdicts(selection.verdicts()), [
        [MANAGER, "paused"],
        [PILOT, "selected"],
      ]);
    });

    it("never lets a paused project's ticket outrank another's, however high its priority", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER, { paused: true, priority: priority(1) });
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [MANAGER, "paused"],
        [PILOT, "selected"],
      ]);
    });
  });

  describe("ready-for-agent eligibility", () => {
    it("never selects a ticket without ready-for-agent, even as its project's only ticket", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addIneligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Not triaged yet",
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("does not select a ticket once it has been handed back", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      const ticket = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await tracker.handBack(ticket, "gave up");
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });
  });

  describe("supertasks", () => {
    it("never selects a ticket carrying the supertask label, even as its project's only ticket", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addSupertask(
        PILOT,
        { number: issueNumber(66), title: "Too big for one run" },
      );
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("stays unselectable once every sub-issue has closed, unlike a blocked ticket regaining eligibility", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addSupertask(PILOT, {
        number: issueNumber(66),
        title: "Too big for one run",
      });
      const subIssue = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(67),
        title: "One of the slices",
        parent: issueNumber(66),
      });
      tracker.closeOutOfBand(subIssue);
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("selects a sibling ticket instead, when one in the same backlog is a supertask", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addSupertask(
        PILOT,
        { number: issueNumber(66), title: "Too big for one run" },
      );
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(67),
        title: "One of the slices",
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 67);
      // Selected for #67, yet the verdict still names #66 as passed over.
      assert.deepEqual(
        selection.verdicts()[0]?.supertasks?.map((ticket) => ticket.number),
        [66],
      );
    });

    it("reads a backlog that is only supertasks as having no eligible tickets, not an error", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER);
      store.register(PILOT);
      tracker.addSupertask(
        MANAGER,
        { number: issueNumber(66), title: "Too big for one run" },
      );
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [MANAGER, "no-eligible-tickets"],
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("selects a ticket whose only open sub-issue is a review ticket", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      const implementation = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      // Handed back, so the review itself is not what gets selected.
      tracker.addIneligibleTicket(PILOT, {
        number: issueNumber(42),
        title: reviewTitle(implementation),
        pullRequest: {
          kind: "review",
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/1"),
        },
        parent: issueNumber(7),
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 7);
    });

    it("selects a ticket whose only open sub-issue is an apply-review ticket", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      // Handed back, so the apply-review itself is not what gets selected.
      tracker.addIneligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on #1",
        pullRequest: {
          kind: "apply-review",
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/1"),
        },
        parent: issueNumber(7),
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 7);
    });

    it("names a passed-over ticket as a supertask, so a full-looking backlog is explicable", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addSupertask(
        PILOT,
        { number: issueNumber(66), title: "Too big for one run" },
      );
      const { selection } = await open(store, tracker);

      await selection.next();

      assert.deepEqual(
        selection.verdicts()[0]?.supertasks?.map((ticket) => ticket.number),
        [66],
      );
    });
  });

  describe("missing supertask label", () => {
    it("flags, but still selects, a ticket with an open sub-issue that is not a pull request ticket and carries no supertask label", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(9),
        title: "Build part of the thing",
        parent: issueNumber(7),
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 7);
      assert.deepEqual(
        selection.verdicts()[0]?.missingSupertaskLabel?.map((ticket) => ticket.number),
        [7],
      );
    });

    it("flags a ready-for-human spec too, not only tickets in this scan's own backlog", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addIneligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(9),
        title: "Build part of the thing",
        parent: issueNumber(7),
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 9);
      assert.deepEqual(
        selection.verdicts()[0]?.missingSupertaskLabel?.map((ticket) => ticket.number),
        [7],
      );
    });

    it("does not flag a ticket that already carries the supertask label", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addSupertask(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(9),
        title: "Build part of the thing",
        parent: issueNumber(7),
      });
      const { selection } = await open(store, tracker);

      await selection.next();

      assert.equal(selection.verdicts()[0]?.missingSupertaskLabel, undefined);
    });

    it("does not flag a ticket whose only open sub-issue is a review ticket", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      const implementation = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addIneligibleTicket(PILOT, {
        number: issueNumber(42),
        title: reviewTitle(implementation),
        pullRequest: {
          kind: "review",
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/1"),
        },
        parent: issueNumber(7),
      });
      const { selection } = await open(store, tracker);

      await selection.next();

      assert.equal(selection.verdicts()[0]?.missingSupertaskLabel, undefined);
    });

    it("does not flag a ticket whose only open sub-issue is an apply-review ticket", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addIneligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on #1",
        pullRequest: {
          kind: "apply-review",
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/1"),
        },
        parent: issueNumber(7),
      });
      const { selection } = await open(store, tracker);

      await selection.next();

      assert.equal(selection.verdicts()[0]?.missingSupertaskLabel, undefined);
    });
  });

  describe("blocked tickets", () => {
    it("never selects a ticket carrying ready-for-agent that an open ticket blocks, even as its project's only ticket", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addBlockedTicket(PILOT, { number: issueNumber(56), title: "Waits on #55" }, 1);
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("selects a sibling ticket instead, and names the blocked one as passed over", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addBlockedTicket(PILOT, { number: issueNumber(56), title: "Waits on #55" }, 2);
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(55),
        title: "The blocker",
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 55);
      assert.deepEqual(
        selection.verdicts()[0]?.blocked?.map((ticket) => ticket.number),
        [56],
      );
    });
  });

  describe("selection ordering", () => {
    /** The pull request every `reviewOf` in this suite names, since none of them care which. */
    const SOME_PULL_REQUEST = pullRequestUrl(
      "https://github.com/nadav-alon/pilot/pull/1",
    );

    /**
     * A ticket that names `parent`'s pull request, ready to add to `parent`'s
     * own repo — a review always lives beside the ticket it reviews, never in
     * another project. Naming the pull request, not just the title, is what
     * `isReviewTicket` reads to tell it from an implementation.
     */
    function reviewOf(
      parent: Ticket,
      number: number,
    ): Omit<Ticket, "repo" | "modelLabel" | "sizeLabel" | "supertask" | "specReview"> {
      return {
        number: issueNumber(number),
        title: reviewTitle(parent),
        pullRequest: { kind: "review", url: SOME_PULL_REQUEST },
      };
    }

    /** A ticket asking for the review on `SOME_PULL_REQUEST` to be applied. */
    function applyReviewTicket(
      number: number,
    ): Omit<Ticket, "repo" | "modelLabel" | "sizeLabel" | "supertask" | "specReview"> {
      return {
        number: issueNumber(number),
        title: `Apply the review on ${SOME_PULL_REQUEST}`,
        pullRequest: { kind: "apply-review", url: SOME_PULL_REQUEST },
      };
    }

    /** A ticket asking for `SOME_PULL_REQUEST` to be rebased. */
    function rebaseTicket(
      number: number,
    ): Omit<Ticket, "repo" | "modelLabel" | "sizeLabel" | "supertask" | "specReview"> {
      return {
        number: issueNumber(number),
        title: `Rebase ${SOME_PULL_REQUEST}`,
        pullRequest: { kind: "rebase", url: SOME_PULL_REQUEST },
      };
    }

    it("selects a rebase ticket over an older apply-review ticket in the same backlog", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, applyReviewTicket(8));
      tracker.addEligibleTicket(PILOT, rebaseTicket(9));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 9);
    });

    it("selects a project with a rebase ticket before one with an apply-review ticket, even with explicit registry priority", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER, { priority: priority(1) });
      tracker.addEligibleTicket(MANAGER, applyReviewTicket(4));
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, rebaseTicket(8));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
    });

    it("selects an apply-review ticket over an older review ticket in the same backlog", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      const implementation = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addEligibleTicket(PILOT, reviewOf(implementation, 8));
      tracker.addEligibleTicket(PILOT, applyReviewTicket(9));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 9);
    });

    it("with two apply-review tickets, the oldest wins whatever ticket priority the newer carries", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, {
        ...applyReviewTicket(9),
        priority: ticketPriority(1),
      });
      tracker.addEligibleTicket(PILOT, {
        ...applyReviewTicket(8),
        priority: ticketPriority(3),
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 8);
    });

    it("selects a project with only an apply-review ticket before one with only an implementation ticket, regardless of registry order", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER);
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, applyReviewTicket(8));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
    });

    it("selects a project with an apply-review ticket before one with a review ticket, even with explicit registry priority", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER, { priority: priority(1) });
      const implementation = tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      tracker.addEligibleTicket(MANAGER, reviewOf(implementation, 4));
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, applyReviewTicket(8));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
    });

    it("selects a project holding both pull request kinds before a review-only project with explicit registry priority, and its apply-review ticket first", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER, { priority: priority(1) });
      const managerImplementation = tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      tracker.addEligibleTicket(MANAGER, reviewOf(managerImplementation, 4));
      store.register(PILOT);
      const pilotImplementation = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addEligibleTicket(PILOT, reviewOf(pilotImplementation, 8));
      tracker.addEligibleTicket(PILOT, applyReviewTicket(9));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
      assert.equal(chosen?.ticket.number, 9);
    });

    it("selects an apply-review ticket over an older implementation ticket with explicit ticket priority", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
        priority: ticketPriority(1),
      });
      tracker.addEligibleTicket(PILOT, applyReviewTicket(9));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 9);
    });

    it("selects a review ticket before an implementation ticket in the same backlog", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      const implementation = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      // Added after the implementation ticket, so winning proves the rule
      // rather than just reflecting backlog order.
      tracker.addEligibleTicket(PILOT, reviewOf(implementation, 8));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 8);
    });

    it("selects a project with a pending review before one with only an implementation ticket, regardless of registry order", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER);
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      store.register(PILOT);
      const implementation = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addEligibleTicket(PILOT, reviewOf(implementation, 8));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      // PILOT's review goes first, however MANAGER — registered first, no
      // priority set for either — would otherwise have sorted.
      assert.equal(chosen?.project.repo, PILOT);
      assert.equal(chosen?.ticket.number, 8);
    });

    it("selects a review ticket over an older spec review ticket in the same backlog", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      const implementation = tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      tracker.addSpecReviewTicket(PILOT, {
        number: issueNumber(8),
        title: "Review the loop spec",
      });
      tracker.addEligibleTicket(PILOT, reviewOf(implementation, 9));
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 9);
    });

    it("selects a spec review ticket over an older implementation ticket in the same backlog", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      // Added after the implementation ticket, so winning proves the rule
      // rather than just reflecting backlog order.
      tracker.addSpecReviewTicket(PILOT, {
        number: issueNumber(8),
        title: "Review the loop spec",
      });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 8);
    });

    it("among implementation tickets, an explicit priority wins over registry order", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER);
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      store.register(PILOT, { priority: priority(1) });
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
    });

    it("a lower priority number wins over a higher one", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER, { priority: priority(2) });
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      store.register(PILOT, { priority: priority(1) });
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
    });

    it("with no priorities set, the least recently worked project wins", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER);
      store.markWorked(MANAGER, YESTERDAY);
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      store.register(PILOT);
      store.markWorked(PILOT, LAST_WEEK);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
    });

    it("a project never worked outranks one that has been, priorities being equal", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(MANAGER);
      store.markWorked(MANAGER, YESTERDAY);
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(3),
        title: "Add another thing",
      });
      // Never worked: no state entry at all, not even an old one.
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, PILOT);
    });

    describe("ticket priority, within one project", () => {
      it("a priority:1 ticket is selected over an older unlabelled ticket", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
        });
        // Added after #7, so winning proves priority rather than backlog order.
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 8);
      });

      it("a priority:1 ticket is selected over an older priority:2 ticket", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
          priority: ticketPriority(2),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 8);
      });

      it("with neither ticket labelled, the oldest ticket wins whatever order the tracker returns them in", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        // Added in descending order, so winning proves the tie-break rather
        // than reflecting backlog order.
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: "Add the other thing",
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 7);
      });

      it("an unlabelled sub-issue of a ready-for-human priority:1 spec is selected over an older priority:2 ticket", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addIneligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "The urgent spec",
          priority: ticketPriority(1),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
          priority: ticketPriority(2),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(9),
          title: "Build part of the urgent spec",
          parent: issueNumber(5),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 9);
      });

      it("an unlabelled blocker of a priority:1 ticket is selected over an older priority:2 ticket", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "The urgent thing",
          priority: ticketPriority(1),
          openBlockers: 1,
          openBlockerNumbers: [issueNumber(9)],
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
          priority: ticketPriority(2),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(9),
          title: "What the urgent thing waits on",
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 9);
        assert.deepEqual(
          selection.verdicts()[0]?.blocked?.map((ticket) => ticket.number),
          [5],
        );
      });

      it("never selects a ready-for-human issue, even carrying priority:1", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addIneligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "The urgent spec",
          priority: ticketPriority(1),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
          priority: ticketPriority(2),
        });
        const { selection, worked } = await open(store, tracker);

        const selections = await drain(selection, worked);

        assert.deepEqual(
          selections.map((selected) => selected.ticket.number),
          [7],
        );
      });

      it("never lets a priority label carried into a sub-issue make its project outrank one with explicit registry priority", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(MANAGER, { priority: priority(1) });
        tracker.addEligibleTicket(MANAGER, {
          number: issueNumber(3),
          title: "Add another thing",
        });
        store.register(PILOT);
        tracker.addIneligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "The urgent spec",
          priority: ticketPriority(1),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(9),
          title: "Build part of the urgent spec",
          parent: issueNumber(5),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.project.repo, MANAGER);
      });

      it("a review ticket is selected over an implementation ticket a priority:1 spec's label carries into", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addIneligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "The urgent spec",
          priority: ticketPriority(1),
        });
        const implementation = tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(9),
          title: "Build part of the urgent spec",
          parent: issueNumber(5),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(10),
          title: reviewTitle(implementation),
          pullRequest: { kind: "review", url: SOME_PULL_REQUEST },
          parent: issueNumber(7),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 10);
      });

      it("passes over a ticket worked today however high the ticket priority carried into it", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addIneligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "The urgent spec",
          priority: ticketPriority(1),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
          priority: ticketPriority(2),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(9),
          title: "Build part of the urgent spec",
          parent: issueNumber(5),
        });
        store.markWorkedOn(TODAY, { repo: PILOT, number: issueNumber(9) });
        const { selection, worked } = await open(store, tracker);

        const selections = await drain(selection, worked);

        assert.deepEqual(
          selections.map((selected) => selected.ticket.number),
          [7],
        );
      });

      it("a review ticket is selected over a priority:1 implementation ticket", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        const implementation = tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
          priority: ticketPriority(1),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: reviewTitle(implementation),
          pullRequest: { kind: "review", url: SOME_PULL_REQUEST },
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 8);
      });

      it("with two review tickets, the oldest ticket wins whatever order the tracker returns them in", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        const first = tracker.addEligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "Add the thing",
        });
        const second = tracker.addEligibleTicket(PILOT, {
          number: issueNumber(6),
          title: "Add the other thing",
        });
        // Added in descending order, so winning proves the tie-break rather
        // than reflecting backlog order.
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(9),
          title: reviewTitle(second),
          pullRequest: {
            kind: "review",
            url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/2"),
          },
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: reviewTitle(first),
          pullRequest: { kind: "review", url: SOME_PULL_REQUEST },
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 8);
      });

      it("with two review tickets, the oldest wins even where ticket priority reaches only the newer one's parent", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        const first = tracker.addEligibleTicket(PILOT, {
          number: issueNumber(5),
          title: "Add the thing",
        });
        const urgent = tracker.addEligibleTicket(PILOT, {
          number: issueNumber(6),
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: reviewTitle(first),
          pullRequest: { kind: "review", url: SOME_PULL_REQUEST },
          parent: issueNumber(5),
        });
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(9),
          title: reviewTitle(urgent),
          pullRequest: {
            kind: "review",
            url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/2"),
          },
          parent: issueNumber(6),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.ticket.number, 8);
      });

      it("never lets a ticket's priority make its project outrank one with explicit registry priority", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(MANAGER, { priority: priority(1) });
        tracker.addEligibleTicket(MANAGER, {
          number: issueNumber(3),
          title: "Add another thing",
        });
        store.register(PILOT);
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.project.repo, MANAGER);
      });

      it("never lets a ticket's priority make its project outrank one worked less recently", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(MANAGER);
        tracker.addEligibleTicket(MANAGER, {
          number: issueNumber(3),
          title: "Add another thing",
        });
        // MANAGER was never worked, so it waits longest; the ticket priority on
        // PILOT's ticket must not be what wins it the morning.
        store.register(PILOT);
        store.markWorked(PILOT, YESTERDAY);
        tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });
        const { selection } = await open(store, tracker);

        const chosen = await selection.next();

        assert.equal(chosen?.project.repo, MANAGER);
      });
    });

    describe("a truncated backlog", () => {
      it("sets backlogTruncated on the selected project", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
        tracker.truncateBacklog(PILOT);
        const { selection } = await open(store, tracker);

        await selection.next();

        assert.equal(selection.verdicts()[0]?.backlogTruncated, true);
      });

      it("sets backlogTruncated on a project another outranked", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(MANAGER, { priority: priority(1) });
        tracker.addEligibleTicket(MANAGER, {
          number: issueNumber(3),
          title: "Add another thing",
        });
        store.register(PILOT);
        tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
        tracker.truncateBacklog(PILOT);
        const { selection } = await open(store, tracker);

        // One scan only: PILOT's verdict from this first scan is the one
        // being checked, before a later scan could give it another turn.
        await selection.next();

        const pilot = selection
          .verdicts()
          .find(({ repo }) => repo === PILOT);
        assert.equal(pilot?.verdict, "deferred");
        assert.equal(pilot?.backlogTruncated, true);
      });

      it("sets backlogTruncated on a project with no eligible tickets", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addSupertask(
          PILOT,
          { number: issueNumber(66), title: "Too big for one run" },
        );
        tracker.truncateBacklog(PILOT);
        const { selection } = await open(store, tracker);

        await selection.next();

        assert.equal(selection.verdicts()[0]?.verdict, "no-eligible-tickets");
        assert.equal(selection.verdicts()[0]?.backlogTruncated, true);
      });

      it("leaves backlogTruncated absent for an untruncated listing", async () => {
        const store = new FakeStore();
        const tracker = new FakeIssueTracker();
        store.register(PILOT);
        tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
        const { selection } = await open(store, tracker);

        await selection.next();

        assert.equal(selection.verdicts()[0]?.backlogTruncated, undefined);
      });
    });
  });

  describe("state", () => {
    it("reports a project with no state as never worked", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      const { selection } = await open(store, tracker);

      await selection.next();

      assert.equal(selection.verdicts()[0]?.lastWorkedAt, undefined);
    });

    it("reports when a project was last worked", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      store.markWorked(PILOT, YESTERDAY);
      const { selection } = await open(store, tracker);

      await selection.next();

      assert.deepEqual(selection.verdicts()[0]?.lastWorkedAt, YESTERDAY);
    });
  });

  describe("tickets worked today", () => {
    it("does not select a ticket an earlier invocation worked today", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(8),
        title: "Add the other thing",
      });
      store.markWorkedOn(TODAY, { repo: PILOT, number: issueNumber(7) });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 8);
    });

    it("still selects another project's ticket with the same number as one worked today", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      store.register(MANAGER);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      tracker.addEligibleTicket(MANAGER, {
        number: issueNumber(7),
        title: "Add the other thing",
      });
      store.markWorkedOn(TODAY, { repo: PILOT, number: issueNumber(7) });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.project.repo, MANAGER);
      assert.equal(chosen?.ticket.number, 7);
    });

    it("reads a project whose only ticket was worked today as already worked today", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      store.markWorkedOn(TODAY, { repo: PILOT, number: issueNumber(7) });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [PILOT, "already-worked-today"],
      ]);
    });

    it("reads a project as already worked today even when a blocked ticket is also left in its backlog", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(55), title: "The blocker" });
      tracker.addBlockedTicket(PILOT, { number: issueNumber(56), title: "Waits on #55" }, 1);
      store.markWorkedOn(TODAY, { repo: PILOT, number: issueNumber(55) });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [
        [PILOT, "already-worked-today"],
      ]);
    });

    it("selects a ticket again once the day it was worked on has passed", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      store.markWorkedOn(localDay(YESTERDAY), { repo: PILOT, number: issueNumber(7) });
      const { selection } = await open(store, tracker);

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 7);
    });
  });

  describe("conflict sweep", () => {
    const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");

    it("sweeps a non-paused project's pull requests before selecting", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      store.register(PILOT);
      repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      repoHost.mergeStatus = () => "conflicting";
      const { selection } = await open(store, tracker, { repoHost });

      await selection.next();

      assert.deepEqual(repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: NEEDS_REBASE },
      ]);
      assert.deepEqual(selection.sweeps(), [
        { repo: PILOT, changes: [{ pullRequest: PULL_REQUEST, action: "labelled" }], refusals: [] },
      ]);
    });

    it("never sweeps a paused project", async (t) => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      store.register(PILOT, { paused: true });
      const listOpenPullRequests = t.mock.method(repoHost, "listOpenPullRequests");
      const { selection } = await open(store, tracker, { repoHost });

      await selection.next();

      assert.equal(listOpenPullRequests.mock.callCount(), 0);
      assert.deepEqual(selection.sweeps(), []);
    });

    it("sweeps whether or not anything in the project is eligible", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      store.register(PILOT);
      repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      repoHost.mergeStatus = () => "conflicting";
      const { selection } = await open(store, tracker, { repoHost });

      const chosen = await selection.next();

      assert.equal(chosen, undefined);
      assert.deepEqual(verdicts(selection.verdicts()), [[PILOT, "no-eligible-tickets"]]);
      assert.deepEqual(repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: NEEDS_REBASE },
      ]);
    });

    it("tells a turbo project's sweep it is turbo, and a plain project's it is not", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      const TURBO_PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/side-projects-manager/pull/9");
      store.register(PILOT);
      store.register(MANAGER, { turbo: true });
      repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      repoHost.setOpenPullRequests(MANAGER, [
        { url: TURBO_PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      repoHost.mergeStatus = () => "conflicting";
      const { selection } = await open(store, tracker, { repoHost });

      await selection.next();

      assert.deepEqual(repoHost.comments, [
        { pullRequest: TURBO_PULL_REQUEST, body: REBASE_COMMENT },
      ]);
    });

    it("posts /rebase on a turbo project's pull request at most once across several scans of one invocation", async () => {
      // The rebase ticket a posted comment opens takes a moment to exist: a
      // later scan of the same invocation still reads no open rebase ticket
      // for the pull request its predecessor already commented on.
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      store.register(PILOT, { turbo: true });
      repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      repoHost.mergeStatus = () => "conflicting";
      const { selection } = await open(store, tracker, { repoHost });

      await selection.next();
      await selection.next();

      assert.deepEqual(repoHost.comments, [
        { pullRequest: PULL_REQUEST, body: REBASE_COMMENT },
      ]);
      const commented = selection
        .sweeps()
        .flatMap((swept) =>
          swept.changes.filter((change) => change.action === "commented"),
        );
      assert.equal(commented.length, 1);
    });

    it("reuses the open issues read selection already makes, rather than listing again", async (t) => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      store.register(PILOT);
      store.register(MANAGER);
      repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      repoHost.mergeStatus = () => "conflicting";
      const listOpenIssues = t.mock.method(tracker, "listOpenIssues");
      const { selection } = await open(store, tracker, { repoHost });

      await selection.next();

      assert.equal(listOpenIssues.mock.callCount(), 2);
      assert.deepEqual(repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: NEEDS_REBASE },
      ]);
    });

    it("accumulates every sweep across several calls to next", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      store.register(PILOT);
      const { selection } = await open(store, tracker, { repoHost });

      await selection.next();
      await selection.next();

      assert.deepEqual(selection.sweeps(), [
        { repo: PILOT, changes: [], refusals: [] },
        { repo: PILOT, changes: [], refusals: [] },
      ]);
    });

    it("a sweep's refusal does not stop selection", async () => {
      const store = new FakeStore();
      const tracker = new FakeIssueTracker();
      const repoHost = new FakeRepoHost();
      store.register(PILOT);
      tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      repoHost.listOpenPullRequests = async () => {
        throw new Error("host unreachable");
      };
      const { selection } = await open(store, tracker, { repoHost });

      const chosen = await selection.next();

      assert.equal(chosen?.ticket.number, 7);
      assert.deepEqual(selection.sweeps(), [
        { repo: PILOT, changes: [], refusals: [{ action: "list", error: "host unreachable" }] },
      ]);
    });
  });
});

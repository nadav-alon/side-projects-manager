import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repoSlug } from "../ports/index.ts";
import { FakeIssueTracker } from "./fake-issue-tracker.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("FakeIssueTracker", () => {
  it("lists only tickets carrying ready-for-agent", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
    tracker.addIneligibleTicket(PILOT, {
      number: 8,
      title: "Not triaged yet",
    });

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.deepEqual(
      backlog.map((ticket) => ticket.number),
      [7],
    );
  });

  it("no longer lists a ticket once it has been handed back", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: 7,
      title: "Add the thing",
    });

    await tracker.handBack(ticket, "gave up");

    assert.deepEqual(await tracker.listEligibleTickets(PILOT), []);
  });

  it("lists a blocked ticket alongside its open blocker count", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addBlockedTicket(PILOT, { number: 56, title: "Waits on #55" }, 2);

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.equal(backlog[0]?.openBlockers, 2);
  });

  it("lists a broken-out ticket alongside its open sub-issue count", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addBrokenOutTicket(
      PILOT,
      { number: 66, title: "Too big for one run" },
      7,
    );

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.equal(backlog[0]?.openSubIssues, 7);
  });
});

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
});

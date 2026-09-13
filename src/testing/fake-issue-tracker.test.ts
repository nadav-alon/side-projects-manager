import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  modelName,
  pullRequestUrl,
  repoSlug,
  type Ticket,
} from "../ports/index.ts";
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

/** The same readings `ghIssueTracker`'s own tests check, from the labels the fake holds. */
describe("FakeIssueTracker — model labels", () => {
  it("names no model for a ticket without a model label", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.equal(backlog[0]?.modelLabel, undefined);
  });

  it("reads the model label from labels alone, never from the ticket it was given", async () => {
    const tracker = new FakeIssueTracker();
    const given: Ticket = {
      repo: PILOT,
      number: 7,
      title: "Add the thing",
      modelLabel: { kind: "named", name: modelName("opus") },
    };
    tracker.addEligibleTicket(PILOT, given);

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.equal(backlog[0]?.modelLabel, undefined);
  });

  it("names the model a ticket labelled model:opus asks for", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
    tracker.addLabel(ticket, "model:opus");

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "named",
      name: modelName("opus"),
    });
  });

  it("passes a name no Claude model uses through unchanged", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
    tracker.addLabel(ticket, "model:GPT-9-Turbo");

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "named",
      name: modelName("GPT-9-Turbo"),
    });
  });

  it("marks a ticket with two model labels as conflicting, with both names", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
    tracker.addLabel(ticket, "model:opus");
    tracker.addLabel(ticket, "model:haiku");

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.equal(backlog.length, 1, "a conflicting ticket is still returned");
    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "conflicting",
      names: [modelName("opus"), modelName("haiku")],
    });
  });

  it("marks a ticket whose model label names no usable model as unusable", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
    tracker.addLabel(ticket, "model:claude opus");

    const backlog = await tracker.listEligibleTickets(PILOT);

    assert.equal(backlog.length, 1, "an unusable ticket is still returned");
    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "unusable",
      labels: ["model:claude opus"],
    });
  });

  it("reads a review ticket's own labels, not its parent's", async () => {
    const tracker = new FakeIssueTracker();
    const parent = tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
    tracker.addLabel(parent, "model:opus");

    const review = await tracker.createReviewTicket(
      parent,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );
    const backlog = await tracker.listEligibleTickets(PILOT);

    const listed = backlog.find((ticket) => ticket.number === review.number);
    assert.ok(listed);
    assert.equal(listed.modelLabel, undefined);
  });

  it("reads the labels afresh on every call", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
    tracker.addLabel(ticket, "model:opus");
    const before = await tracker.listEligibleTickets(PILOT);

    tracker.removeLabel(ticket, "model:opus");
    tracker.addLabel(ticket, "model:sonnet");
    const after = await tracker.listEligibleTickets(PILOT);

    assert.deepEqual(before[0]?.modelLabel, { kind: "named", name: modelName("opus") });
    assert.deepEqual(after[0]?.modelLabel, { kind: "named", name: modelName("sonnet") });
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backlogIn,
  isApplyReviewTicket,
  isRebaseTicket,
  isReviewTicket,
  isSpecReviewTicket,
  isSupertask,
  issueNumber,
  modelName,
  pullRequestUrl,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  repoSlug,
  ticketPriority,
  type ApplyReviewTicket,
  type RebaseTicket,
  type Ticket,
} from "../ports/index.ts";
import { FakeIssueTracker } from "./fake-issue-tracker.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("FakeIssueTracker", () => {
  it("lists only tickets carrying ready-for-agent", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addIneligibleTicket(PILOT, {
      number: issueNumber(8),
      title: "Not triaged yet",
    });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.deepEqual(
      backlog.map((ticket) => ticket.number),
      [7],
    );
  });

  it("no longer lists a ticket once it has been handed back", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const outcome = await tracker.handBack(ticket, "gave up");

    assert.equal(outcome, "handed-back");
    assert.deepEqual(backlogIn(await tracker.listOpenIssues(PILOT)).tickets, []);
  });

  it("leaves a closed ticket's labels alone and records no comment when handed back", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });
    tracker.closeOutOfBand(ticket);

    const outcome = await tracker.handBack(ticket, "gave up");

    assert.equal(outcome, "already-closed");
    assert.deepEqual(tracker.handbacks, []);
    assert.equal(tracker.carriesLabel(ticket, READY_FOR_AGENT_LABEL), true);
    assert.equal(tracker.carriesLabel(ticket, READY_FOR_HUMAN_LABEL), false);
  });

  it("no longer lists a review ticket, nor carries ready-for-agent on it, once closed", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });
    const review = await tracker.createReviewTicket(
      ticket,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );
    assert.ok(isReviewTicket(review));

    await tracker.closeReviewTicket(review);

    const { issues } = await tracker.listOpenIssues(PILOT);
    assert.ok(!issues.some((issue) => issue.ticket.number === review.number));
    assert.equal(tracker.carriesLabel(review, READY_FOR_AGENT_LABEL), false);
  });

  it("lists a blocked ticket alongside its open blocker count", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addBlockedTicket(PILOT, { number: issueNumber(56), title: "Waits on #55" }, 2);

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(backlog[0]?.openBlockers, 2);
  });

  it("lists a ticket alongside the ticket priority it was given", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
      priority: ticketPriority(2),
    });

    const { tickets } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(tickets[0]?.priority, 2);
  });

  it("reports a backlog as truncated only once set up as one", async () => {
    const tracker = new FakeIssueTracker();
    const OTHER = repoSlug("nadav-alon/other");
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addEligibleTicket(OTHER, { number: issueNumber(1), title: "Another" });

    tracker.truncateBacklog(PILOT);

    const pilot = backlogIn(await tracker.listOpenIssues(PILOT));
    const other = backlogIn(await tracker.listOpenIssues(OTHER));
    assert.equal(pilot.truncated, true);
    assert.deepEqual(
      pilot.tickets.map((ticket) => ticket.number),
      [7],
    );
    assert.equal(other.truncated, false);
  });

  it("lists every open issue, marking eligible only those carrying ready-for-agent", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addIneligibleTicket(PILOT, {
      number: issueNumber(5),
      title: "Spec: the thing",
      priority: ticketPriority(1),
    });

    const { issues } = await tracker.listOpenIssues(PILOT);

    assert.deepEqual(
      issues.map(({ ticket: { number, priority }, eligible }) => ({ number, eligible, priority })),
      [
        { number: 7, eligible: true, priority: undefined },
        { number: 5, eligible: false, priority: 1 },
      ],
    );
  });

  it("lists an issue alongside its parent and open blocker numbers", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, {
      number: issueNumber(8),
      title: "Part of the spec",
      parent: issueNumber(5),
      openBlockerNumbers: [issueNumber(6)],
    });

    const { issues } = await tracker.listOpenIssues(PILOT);

    assert.equal(issues[0]?.parent, 5);
    assert.deepEqual(issues[0]?.openBlockerNumbers, [6]);
  });

  it("lists no blocker numbers for an issue given none", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });

    const { issues } = await tracker.listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.openBlockerNumbers, []);
    assert.equal(issues[0]?.parent, undefined);
  });

  it("lists a supertask carrying the supertask label", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addSupertask(PILOT, {
      number: issueNumber(66),
      title: "Too big for one run",
    });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(isSupertask(backlog[0] as Ticket), true);
  });

  it("lists a spec review ticket carrying the spec review label", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addSpecReviewTicket(PILOT, {
      number: issueNumber(67),
      title: "Review the loop spec",
    });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(isSpecReviewTicket(backlog[0] as Ticket), true);
  });

  it("does not read an ordinary ticket as a spec review", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: issueNumber(68), title: "Add the thing" });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(isSpecReviewTicket(backlog[0] as Ticket), false);
  });

  it("holds an apply-review ticket, bound to the pull request it names", async () => {
    const tracker = new FakeIssueTracker();
    const pullRequest = pullRequestUrl(
      "https://github.com/nadav-alon/pilot/pull/12",
    );
    tracker.addEligibleTicket(PILOT, {
      number: issueNumber(9),
      title: "Apply the review",
      pullRequest: { kind: "apply-review", url: pullRequest },
    });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(isApplyReviewTicket(backlog[0] as Ticket), true);
    assert.deepEqual((backlog[0] as Ticket).pullRequest, {
      kind: "apply-review",
      url: pullRequest,
    });
  });

  it("closes an apply-review ticket, recording its comment and taking it off the open issues", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(9),
      title: "Apply the review",
      pullRequest: {
        kind: "apply-review",
        url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
      },
    }) as ApplyReviewTicket;

    await tracker.closeApplyReviewTicket(ticket, "Nothing to apply.");

    assert.deepEqual(tracker.closedApplyReviewTickets, [
      { ticket, comment: "Nothing to apply." },
    ]);
    const { issues } = await tracker.listOpenIssues(PILOT);
    assert.deepEqual(issues, []);
  });

  it("holds a rebase ticket, bound to the pull request it names", async () => {
    const tracker = new FakeIssueTracker();
    const pullRequest = pullRequestUrl(
      "https://github.com/nadav-alon/pilot/pull/12",
    );
    tracker.addEligibleTicket(PILOT, {
      number: issueNumber(9),
      title: "Rebase",
      pullRequest: { kind: "rebase", url: pullRequest },
    });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(isRebaseTicket(backlog[0] as Ticket), true);
    assert.deepEqual((backlog[0] as Ticket).pullRequest, {
      kind: "rebase",
      url: pullRequest,
    });
  });

  it("closes a rebase ticket, recording its comment and taking it off the open issues", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(9),
      title: "Rebase",
      pullRequest: {
        kind: "rebase",
        url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
      },
    }) as RebaseTicket;

    await tracker.closeRebaseTicket(ticket, "Already sits on its base.");

    assert.deepEqual(tracker.closedRebaseTickets, [
      { ticket, comment: "Already sits on its base." },
    ]);
    const { issues } = await tracker.listOpenIssues(PILOT);
    assert.deepEqual(issues, []);
  });
});

/** The same readings `ghIssueTracker`'s own tests check, from the labels the fake holds. */
describe("FakeIssueTracker — model labels", () => {
  it("names no model for a ticket without a model label", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(backlog[0]?.modelLabel, undefined);
  });

  /** Checked by the type check: the model label comes from labels alone. */
  it("takes no model label with the ticket it is given", () => {
    const tracker = new FakeIssueTracker();
    const given: Ticket = {
      repo: PILOT,
      number: issueNumber(7),
      title: "Add the thing",
      modelLabel: { kind: "named", name: modelName("opus") },
    };
    // @ts-expect-error: a ticket carrying a model label is not a TicketInput.
    tracker.addEligibleTicket(PILOT, given);
  });

  it("names the model a ticket labelled model:opus asks for", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "model:opus");

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "named",
      name: modelName("opus"),
    });
  });

  it("passes a name no Claude model uses through unchanged", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "model:GPT-9-Turbo");

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "named",
      name: modelName("GPT-9-Turbo"),
    });
  });

  it("marks a ticket with two model labels as conflicting, with both names", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "model:opus");
    tracker.addLabel(ticket, "model:haiku");

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(backlog.length, 1, "a conflicting ticket is still returned");
    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "conflicting",
      names: [modelName("opus"), modelName("haiku")],
      labels: ["model:opus", "model:haiku"],
    });
  });

  it("marks a ticket whose model label names no usable model as unusable", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "model:claude opus");

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(backlog.length, 1, "an unusable ticket is still returned");
    assert.deepEqual(backlog[0]?.modelLabel, {
      kind: "unusable",
      labels: ["model:claude opus"],
    });
  });

  it("reads a review ticket's own labels, not its parent's", async () => {
    const tracker = new FakeIssueTracker();
    const parent = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(parent, "model:opus");

    const review = await tracker.createReviewTicket(
      parent,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );
    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    const listed = backlog.find((ticket) => ticket.number === review.number);
    assert.ok(listed);
    assert.equal(listed.modelLabel, undefined);
  });

  it("reads the labels afresh on every call", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "model:opus");
    const { tickets: before } = backlogIn(await tracker.listOpenIssues(PILOT));

    tracker.removeLabel(ticket, "model:opus");
    tracker.addLabel(ticket, "model:sonnet");
    const { tickets: after } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.deepEqual(before[0]?.modelLabel, { kind: "named", name: modelName("opus") });
    assert.deepEqual(after[0]?.modelLabel, { kind: "named", name: modelName("sonnet") });
  });
});

/** The same readings `ghIssueTracker`'s own tests check, from the labels the fake holds. */
describe("FakeIssueTracker — size labels", () => {
  it("declares no size for a ticket without a size label", async () => {
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.equal(backlog[0]?.sizeLabel, undefined);
  });

  /** Checked by the type check: the size label comes from labels alone. */
  it("takes no size label with the ticket it is given", () => {
    const tracker = new FakeIssueTracker();
    const given: Ticket = {
      repo: PILOT,
      number: issueNumber(7),
      title: "Add the thing",
      sizeLabel: { kind: "declared", size: "M" },
    };
    // @ts-expect-error: a ticket carrying a size label is not a TicketInput.
    tracker.addEligibleTicket(PILOT, given);
  });

  it("declares the size a ticket labelled size:M asks for", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "size:M");

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.deepEqual(backlog[0]?.sizeLabel, { kind: "declared", size: "M" });
  });

  it("counts the larger of two declared sizes", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "size:S");
    tracker.addLabel(ticket, "size:L");

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.deepEqual(backlog[0]?.sizeLabel, { kind: "declared", size: "L" });
  });

  it("marks a ticket whose size label names no recognised size as unusable", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(ticket, "size:huge");

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    assert.deepEqual(backlog[0]?.sizeLabel, {
      kind: "unusable",
      labels: ["size:huge"],
    });
  });

  it("reads a review ticket's own labels, not its parent's", async () => {
    const tracker = new FakeIssueTracker();
    const parent = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.addLabel(parent, "size:XL");

    const review = await tracker.createReviewTicket(
      parent,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );
    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));

    const listed = backlog.find((ticket) => ticket.number === review.number);
    assert.ok(listed);
    assert.equal(listed.sizeLabel, undefined);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backlogIn,
  ENHANCEMENT_LABEL,
  isApplyReviewTicket,
  isRebaseTicket,
  isReviewTicket,
  isSpecReviewTicket,
  isSupertask,
  issueNumber,
  modelName,
  NEEDS_TRIAGE_LABEL,
  pullRequestUrl,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  repoSlug,
  SIZE_S_LABEL,
  ticketPriority,
  TURBOABLE_LABEL,
  type ApplyReviewTicket,
  type RebaseTicket,
  type RunSpan,
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

  it("links a review ticket to the ticket it reviews, as a sub-issue", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });
    const review = await tracker.createReviewTicket(
      ticket,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );

    const { issues } = await tracker.listOpenIssues(PILOT);

    const listed = issues.find((issue) => issue.ticket.number === review.number);
    assert.equal(listed?.parent, ticket.number);
  });

  it("never opens a review ticket carrying turboable", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const review = await tracker.createReviewTicket(
      ticket,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );

    assert.equal(tracker.carriesLabel(review, TURBOABLE_LABEL), false);
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

describe("FakeIssueTracker.comment", () => {
  it("records the comment and touches no label", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    await tracker.comment(ticket, "Found something while working this.");

    assert.deepEqual(tracker.comments, [
      { ticket, comment: "Found something while working this." },
    ]);
    assert.equal(tracker.carriesLabel(ticket, READY_FOR_AGENT_LABEL), true);
  });
});

describe("FakeIssueTracker.createDiscoveredTicket", () => {
  it("opens a ticket carrying needs-triage and enhancement, never ready-for-agent", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const discovered = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
    });

    assert.equal(tracker.carriesLabel(discovered, NEEDS_TRIAGE_LABEL), true);
    assert.equal(tracker.carriesLabel(discovered, ENHANCEMENT_LABEL), true);
    assert.equal(
      tracker.carriesLabel(discovered, READY_FOR_AGENT_LABEL),
      false,
    );
  });

  it("opens a ready ticket carrying ready-for-agent, size:S and enhancement, never needs-triage", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const discovered = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
      ready: true,
    });

    assert.equal(tracker.carriesLabel(discovered, READY_FOR_AGENT_LABEL), true);
    assert.equal(tracker.carriesLabel(discovered, SIZE_S_LABEL), true);
    assert.equal(tracker.carriesLabel(discovered, ENHANCEMENT_LABEL), true);
    assert.equal(tracker.carriesLabel(discovered, NEEDS_TRIAGE_LABEL), false);
    const { issues } = await tracker.listOpenIssues(PILOT);
    const found = issues.find((issue) => issue.ticket.number === discovered.number);
    assert.equal(found?.eligible, true);
  });

  it("marks a ready ticket with the ready discovery label, for the chain guard", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const discovered = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
      ready: true,
    });

    assert.equal(discovered.readyDiscovery, true);
    const { issues } = await tracker.listOpenIssues(PILOT);
    const found = issues.find((issue) => issue.ticket.number === discovered.number);
    assert.equal(found?.ticket.readyDiscovery, true);
  });

  it("never opens a discovered ticket carrying turboable, ready or not", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const notReady = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
    });
    const ready = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off, take two",
      body: "Hammers the API on every failure.",
      ready: true,
    });

    assert.equal(tracker.carriesLabel(notReady, TURBOABLE_LABEL), false);
    assert.equal(tracker.carriesLabel(ready, TURBOABLE_LABEL), false);
  });

  it("numbers it above every ticket the repo has, and lists it as ineligible", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const discovered = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
    });

    assert.equal(discovered.number, 8);
    const { issues } = await tracker.listOpenIssues(PILOT);
    const found = issues.find((issue) => issue.ticket.number === discovered.number);
    assert.equal(found?.eligible, false);
  });

  it("records the call, naming the ticket it was discovered while working", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const discovered = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
    });

    assert.deepEqual(tracker.discoveredTickets, [
      {
        discoveredWhile: ticket,
        title: "The retry loop never backs off",
        body: "Hammers the API on every failure.\n\nDiscovered while working #7.",
        blocking: false,
        ticket: discovered,
      },
    ]);
  });

  it("leaves the ticket's open blocker count untouched without blocking asked for", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
    });

    const { tickets: backlog } = backlogIn(await tracker.listOpenIssues(PILOT));
    assert.equal(backlog.find((t) => t.number === ticket.number)?.openBlockers, undefined);
  });

  it("raises the ticket's open blocker count by one when blocking is asked for", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const discovered = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
      blocking: true,
    });

    const { issues } = await tracker.listOpenIssues(PILOT);
    const found = issues.find((issue) => issue.ticket.number === ticket.number);
    assert.equal(found?.ticket.openBlockers, 1);
    assert.deepEqual(found?.openBlockerNumbers, [discovered.number]);
    assert.deepEqual(tracker.discoveredTickets[0]?.blocking, true);
  });

  it("drops the ticket's open blocker count once the discovered ticket closes", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const discovered = await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
      blocking: true,
    });
    tracker.closeOutOfBand(discovered);

    const { issues } = await tracker.listOpenIssues(PILOT);
    const found = issues.find((issue) => issue.ticket.number === ticket.number);
    assert.equal(found?.ticket.openBlockers, undefined);
    assert.deepEqual(found?.openBlockerNumbers, []);
  });

  it("records no edge, rather than the one asked for, against a ticket the fake never held", async () => {
    const tracker = new FakeIssueTracker();
    const ticket: Ticket = {
      repo: PILOT,
      number: issueNumber(7),
      title: "Add the thing",
    };

    await tracker.createDiscoveredTicket(ticket, {
      title: "The retry loop never backs off",
      body: "Hammers the API on every failure.",
      blocking: true,
    });

    assert.equal(tracker.discoveredTickets[0]?.blocking, false);
  });
});

describe("FakeIssueTracker — sub-issues", () => {
  it("lists a supertask's open sub-issues", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const child = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Part one",
      parent: supertask.number,
    });

    const subIssues = await tracker.listSubIssues(supertask);

    assert.deepEqual(subIssues, [
      { ticket: { repo: PILOT, number: child.number, title: child.title }, closed: false },
    ]);
  });

  it("still lists a closed sub-issue, marked closed", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const child = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Part one",
      parent: supertask.number,
    });
    tracker.closeOutOfBand(child);

    const subIssues = await tracker.listSubIssues(supertask);

    assert.deepEqual(subIssues, [
      { ticket: { repo: PILOT, number: child.number, title: child.title }, closed: true },
    ]);
  });

  it("lists no sub-issues for a ticket nothing names as a parent", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });

    const subIssues = await tracker.listSubIssues(supertask);

    assert.deepEqual(subIssues, []);
  });

  it("opens a spec review ticket carrying ready-for-agent, spec-review and size:L, linked to its supertask", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });

    const specReview = await tracker.createSpecReviewTicket(
      supertask,
      "Reviews #40.",
    );

    assert.equal(tracker.carriesLabel(specReview, READY_FOR_AGENT_LABEL), true);
    const { issues } = await tracker.listOpenIssues(PILOT);
    const listed = issues.find((issue) => issue.ticket.number === specReview.number);
    assert.ok(listed);
    assert.equal(isSpecReviewTicket(listed.ticket), true);
    assert.equal(listed.parent, 40);
    assert.deepEqual(tracker.specReviewTickets, [
      { parent: supertask, body: "Reviews #40.", ticket: specReview },
    ]);
  });

  it("never opens a spec review ticket carrying turboable", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });

    const specReview = await tracker.createSpecReviewTicket(
      supertask,
      "Reviews #40.",
    );

    assert.equal(tracker.carriesLabel(specReview, TURBOABLE_LABEL), false);
  });

  it("links a floating spec review already in the backlog to its supertask", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const floating = tracker.addSpecReviewTicket(PILOT, {
      number: issueNumber(99),
      title: "Spec review for #40",
    });

    await tracker.linkSpecReviewTicket(floating, supertask, async () => "Reviews #40.");

    const { issues } = await tracker.listOpenIssues(PILOT);
    const listed = issues.find((issue) => issue.ticket.number === floating.number);
    assert.equal(listed?.parent, 40);
    assert.deepEqual(tracker.linkedSpecReviewTickets, [
      { parent: supertask, body: "Reviews #40.", ticket: { ...floating, specReview: true } },
    ]);
  });

  it("refuses to link a ticket the backlog never saw", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const neverAdded: Ticket = {
      repo: PILOT,
      number: issueNumber(99),
      title: "Spec review for #40",
      specReview: true,
    };

    await assert.rejects(
      tracker.linkSpecReviewTicket(neverAdded, supertask, async () => "Reviews #40."),
    );
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

describe("FakeIssueTracker.wasTurboableAt", () => {
  const DAY_1 = new Date("2026-01-01T00:00:00Z");
  const DAY_2 = new Date("2026-01-02T00:00:00Z");
  const DAY_3 = new Date("2026-01-03T00:00:00Z");

  it("answers false for a ticket with no recorded turboable event", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });

    assert.equal(await tracker.wasTurboableAt(ticket, DAY_2, []), false);
  });

  it("answers true once turboable was labelled, at and after that instant", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.recordTurboableEvent(ticket, "labeled", DAY_1);

    assert.equal(await tracker.wasTurboableAt(ticket, DAY_1, []), true);
    assert.equal(await tracker.wasTurboableAt(ticket, DAY_2, []), true);
  });

  it("answers false for a turboable label added after the instant", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.recordTurboableEvent(ticket, "labeled", DAY_2);

    assert.equal(await tracker.wasTurboableAt(ticket, DAY_1, []), false);
  });

  it("answers false once turboable was added and then removed again before the instant", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.recordTurboableEvent(ticket, "labeled", DAY_1);
    tracker.recordTurboableEvent(ticket, "unlabeled", DAY_2);

    assert.equal(await tracker.wasTurboableAt(ticket, DAY_3, []), false);
  });

  it("reads only the ticket its events were recorded against", async () => {
    const tracker = new FakeIssueTracker();
    const turboable = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const other = tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Add another thing" });
    tracker.recordTurboableEvent(turboable, "labeled", DAY_1);

    assert.equal(await tracker.wasTurboableAt(other, DAY_2, []), false);
  });

  it("leaves the ticket's current labels untouched, independent of addLabel/removeLabel", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    tracker.recordTurboableEvent(ticket, "labeled", DAY_1);

    assert.equal(tracker.carriesLabel(ticket, TURBOABLE_LABEL), false);
  });

  it("answers false where the grant falls inside another ticket's run span in the same repo", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const other = tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Add another thing" });
    tracker.recordTurboableEvent(ticket, "labeled", DAY_2);

    const spans: RunSpan[] = [
      { repo: other.repo, number: other.number, startedAt: DAY_1, endedAt: DAY_3 },
    ];
    assert.equal(await tracker.wasTurboableAt(ticket, DAY_3, spans), false);
  });

  it("answers false where the grant falls inside another ticket's still-open run span in the same repo", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const other = tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Add another thing" });
    tracker.recordTurboableEvent(ticket, "labeled", DAY_2);

    const spans: RunSpan[] = [{ repo: other.repo, number: other.number, startedAt: DAY_1 }];
    assert.equal(await tracker.wasTurboableAt(ticket, DAY_3, spans), false);
  });

  it("ignores a run span for the same numbered ticket in a different repo", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
    const otherRepo = repoSlug("nadav-alon/other");
    tracker.recordTurboableEvent(ticket, "labeled", DAY_2);

    const spans: RunSpan[] = [
      { repo: otherRepo, number: ticket.number, startedAt: DAY_1, endedAt: DAY_3 },
    ];
    assert.equal(await tracker.wasTurboableAt(ticket, DAY_3, spans), true);
  });
});

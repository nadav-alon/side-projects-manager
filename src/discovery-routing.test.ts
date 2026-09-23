import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  blockingDiscoveriesOf,
  hasBlockingDiscovery,
  isAgentBrief,
  routeDiscoveries,
  routeRunDiscoveries,
} from "./discovery-routing.ts";
import {
  ENHANCEMENT_LABEL,
  NEEDS_TRIAGE_LABEL,
  READY_DISCOVERY_LABEL,
  READY_FOR_AGENT_LABEL,
  issueNumber,
  pullRequestUrl,
  type Discovery,
} from "./ports/index.ts";
import { FakeIssueTracker, PILOT } from "./testing/index.ts";

function implementation() {
  return { number: issueNumber(7), title: "Add the thing" };
}

function discovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    kind: "clarification",
    title: "What #7 means by 'the thing'",
    body: "I read it as the button, not the menu.",
    ...overrides,
  };
}

/** A body shaped as an agent brief, per CONTEXT.md's "Ready discovery". */
const AGENT_BRIEF_BODY = [
  "Current behavior: the retry loop hammers the API on every failure.",
  "Desired behavior: it should back off between attempts.",
  "Acceptance criteria: a failed call waits before its next attempt.",
  "Out of scope: a configurable backoff strategy.",
].join("\n\n");

describe("routeDiscoveries", () => {
  it("comments on the target for a correction or a clarification", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const correction = discovery({ kind: "correction", title: "The ticket names the wrong file" });
    const clarification = discovery({ kind: "clarification" });

    const routing = await routeDiscoveries(tracker, ticket, ticket, [correction, clarification]);

    assert.equal(routing.filed.length, 2);
    assert.ok(routing.filed.every((filed) => filed.action === "commented"));
    assert.equal(tracker.comments.length, 2);
    assert.match(tracker.comments[0]?.comment ?? "", /The ticket names the wrong file/);
    assert.match(tracker.comments[0]?.comment ?? "", /Discovered while working #7/);
  });

  it("opens a discovered ticket that blocks the target for a prerequisite", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const prerequisite = discovery({
      kind: "prerequisite",
      title: "Needs the widget port first",
    });

    const routing = await routeDiscoveries(tracker, ticket, ticket, [prerequisite]);

    assert.equal(routing.filed.length, 1);
    const [filed] = routing.filed;
    assert.equal(filed?.action, "discovered-ticket");
    assert.equal(tracker.discoveredTickets.length, 1);
    assert.equal(tracker.discoveredTickets[0]?.blocking, true);
  });

  it("opens a discovered ticket with no edge for a suggestion", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const suggestion = discovery({ kind: "suggestion", title: "Worth adding a retry" });

    const routing = await routeDiscoveries(tracker, ticket, ticket, [suggestion]);

    assert.equal(routing.filed.length, 1);
    assert.equal(tracker.discoveredTickets[0]?.blocking, false);
  });

  it("files only the first suggestion, dropping and counting the rest", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const suggestions = [
      discovery({ kind: "suggestion", title: "First" }),
      discovery({ kind: "suggestion", title: "Second" }),
      discovery({ kind: "suggestion", title: "Third" }),
    ];

    const routing = await routeDiscoveries(tracker, ticket, ticket, suggestions);

    assert.equal(routing.filed.length, 1);
    assert.equal(tracker.discoveredTickets.length, 1);
    assert.equal(tracker.discoveredTickets[0]?.title, "First");
    assert.equal(routing.suggestionsDropped, 2);
  });

  it("never caps clarifications", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const clarifications = [discovery(), discovery(), discovery()];

    const routing = await routeDiscoveries(tracker, ticket, ticket, clarifications);

    assert.equal(routing.filed.length, 3);
    assert.equal(routing.suggestionsDropped, 0);
  });

  it("does not spend the suggestion cap on a refused first suggestion, so the next one is filed", async (t) => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const realCreateDiscoveredTicket = tracker.createDiscoveredTicket.bind(tracker);
    let calls = 0;
    t.mock.method(tracker, "createDiscoveredTicket", async (...args: Parameters<typeof tracker.createDiscoveredTicket>) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("the tracker refused the ticket");
      }
      return realCreateDiscoveredTicket(...args);
    });
    const suggestions = [
      discovery({ kind: "suggestion", title: "First" }),
      discovery({ kind: "suggestion", title: "Second" }),
    ];

    const routing = await routeDiscoveries(tracker, ticket, ticket, suggestions);

    assert.equal(routing.refused.length, 1);
    assert.equal(routing.refused[0]?.discovery.title, "First");
    assert.equal(routing.filed.length, 1);
    assert.equal(routing.filed[0]?.discovery.title, "Second");
    assert.equal(routing.suggestionsDropped, 0);
  });

  it("reports a refused write without stopping the rest", async (t) => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    let calls = 0;
    t.mock.method(tracker, "comment", async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("the tracker refused the comment");
      }
    });
    const discoveries = [
      discovery({ title: "First" }),
      discovery({ title: "Second" }),
    ];

    const routing = await routeDiscoveries(tracker, ticket, ticket, discoveries);

    assert.equal(routing.refused.length, 1);
    assert.match(routing.refused[0]?.reason ?? "", /refused the comment/);
    assert.equal(routing.filed.length, 1);
    assert.equal(routing.filed[0]?.discovery.title, "Second");
  });

  it("opens a ready prerequisite's ticket ready-for-agent when its body reads as an agent brief, and still blocks the target", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const prerequisite = discovery({
      kind: "prerequisite",
      title: "Needs the widget port first",
      body: AGENT_BRIEF_BODY,
      ready: true,
    });

    const routing = await routeDiscoveries(tracker, ticket, ticket, [prerequisite]);

    const [filed] = routing.filed;
    assert.equal(filed?.action, "discovered-ticket");
    const opened = filed?.action === "discovered-ticket" ? filed.ticket : undefined;
    assert.ok(opened);
    assert.equal(tracker.carriesLabel(opened, READY_FOR_AGENT_LABEL), true);
    assert.equal(tracker.carriesLabel(opened, NEEDS_TRIAGE_LABEL), false);
    assert.equal(tracker.carriesLabel(opened, ENHANCEMENT_LABEL), true);
    assert.equal(tracker.discoveredTickets[0]?.blocking, true);
  });

  it("opens a ready suggestion's ticket ready-for-agent the same way", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const suggestion = discovery({
      kind: "suggestion",
      title: "Worth adding a retry",
      body: AGENT_BRIEF_BODY,
      ready: true,
    });

    const routing = await routeDiscoveries(tracker, ticket, ticket, [suggestion]);

    const [filed] = routing.filed;
    const opened = filed?.action === "discovered-ticket" ? filed.ticket : undefined;
    assert.ok(opened);
    assert.equal(tracker.carriesLabel(opened, READY_FOR_AGENT_LABEL), true);
  });

  it("falls back to needs-triage when a ready discovery's body does not read as an agent brief", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const suggestion = discovery({
      kind: "suggestion",
      title: "Worth adding a retry",
      body: "Just a plain suggestion, no sections at all.",
      ready: true,
    });

    const routing = await routeDiscoveries(tracker, ticket, ticket, [suggestion]);

    const [filed] = routing.filed;
    const opened = filed?.action === "discovered-ticket" ? filed.ticket : undefined;
    assert.ok(opened);
    assert.equal(tracker.carriesLabel(opened, NEEDS_TRIAGE_LABEL), true);
    assert.equal(tracker.carriesLabel(opened, READY_FOR_AGENT_LABEL), false);
  });

  it("falls back to needs-triage when the run's own ticket was itself born from a ready discovery", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    tracker.addLabel(ticket, READY_DISCOVERY_LABEL);
    const { issues } = await tracker.listOpenIssues(PILOT);
    const bornReady = issues.find((issue) => issue.ticket.number === ticket.number)?.ticket;
    assert.ok(bornReady !== undefined);
    assert.equal(bornReady.readyDiscovery, true);
    const suggestion = discovery({
      kind: "suggestion",
      title: "Worth adding a retry",
      body: AGENT_BRIEF_BODY,
      ready: true,
    });

    const routing = await routeDiscoveries(tracker, bornReady, bornReady, [suggestion]);

    const [filed] = routing.filed;
    const opened = filed?.action === "discovered-ticket" ? filed.ticket : undefined;
    assert.ok(opened);
    assert.equal(tracker.carriesLabel(opened, NEEDS_TRIAGE_LABEL), true);
    assert.equal(tracker.carriesLabel(opened, READY_FOR_AGENT_LABEL), false);
  });

  it("falls back to needs-triage when a review run's discovery lands on an implementation ticket born from a ready discovery", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    tracker.addLabel(ticket, READY_DISCOVERY_LABEL);
    const { issues } = await tracker.listOpenIssues(PILOT);
    const bornReady = issues.find((issue) => issue.ticket.number === ticket.number)?.ticket;
    assert.ok(bornReady !== undefined);
    const reviewTicket = await tracker.createReviewTicket(
      bornReady,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );
    const suggestion = discovery({
      kind: "suggestion",
      title: "Worth adding a retry",
      body: AGENT_BRIEF_BODY,
      ready: true,
    });

    const routing = await routeDiscoveries(tracker, reviewTicket, bornReady, [suggestion]);

    const [filed] = routing.filed;
    const opened = filed?.action === "discovered-ticket" ? filed.ticket : undefined;
    assert.ok(opened);
    assert.equal(tracker.carriesLabel(opened, NEEDS_TRIAGE_LABEL), true);
    assert.equal(tracker.carriesLabel(opened, READY_FOR_AGENT_LABEL), false);
  });

  it("ignores ready on a correction or a clarification: both still become comments", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const correction = discovery({
      kind: "correction",
      title: "The ticket names the wrong file",
      body: AGENT_BRIEF_BODY,
      ready: true,
    });
    const clarification = discovery({ body: AGENT_BRIEF_BODY, ready: true });

    const routing = await routeDiscoveries(tracker, ticket, ticket, [correction, clarification]);

    assert.ok(routing.filed.every((filed) => filed.action === "commented"));
    assert.equal(tracker.discoveredTickets.length, 0);
  });
});

describe("isAgentBrief", () => {
  it("accepts a body naming all four sections", () => {
    assert.equal(isAgentBrief(AGENT_BRIEF_BODY), true);
  });

  it("accepts British spelling of behaviour", () => {
    const body = [
      "Current behaviour: nothing happens.",
      "Desired behaviour: it should retry.",
      "Acceptance criteria: retries three times.",
      "Out of scope: backoff.",
    ].join("\n\n");
    assert.equal(isAgentBrief(body), true);
  });

  it("rejects a body missing any one section", () => {
    assert.equal(
      isAgentBrief([
        "Desired behavior: it should retry.",
        "Acceptance criteria: retries three times.",
        "Out of scope: backoff.",
      ].join("\n\n")),
      false,
    );
    assert.equal(
      isAgentBrief([
        "Current behavior: nothing happens.",
        "Acceptance criteria: retries three times.",
        "Out of scope: backoff.",
      ].join("\n\n")),
      false,
    );
    assert.equal(
      isAgentBrief([
        "Current behavior: nothing happens.",
        "Desired behavior: it should retry.",
        "Out of scope: backoff.",
      ].join("\n\n")),
      false,
    );
    assert.equal(
      isAgentBrief([
        "Current behavior: nothing happens.",
        "Desired behavior: it should retry.",
        "Acceptance criteria: retries three times.",
      ].join("\n\n")),
      false,
    );
  });

  it("rejects plain prose with none of the sections", () => {
    assert.equal(isAgentBrief("Worth adding a retry with backoff."), false);
  });
});

describe("hasBlockingDiscovery and blockingDiscoveriesOf", () => {
  it("is false when every discovery is advisory", () => {
    const discoveries = [discovery({ kind: "suggestion" })];
    assert.equal(hasBlockingDiscovery(discoveries), false);
    assert.deepEqual(blockingDiscoveriesOf(discoveries), []);
  });

  it("is true for a correction or a prerequisite, filed or refused makes no difference", () => {
    const correction = discovery({ kind: "correction" });
    assert.equal(hasBlockingDiscovery([correction]), true);
    assert.deepEqual(blockingDiscoveriesOf([correction]), [correction]);
  });

  it("keeps the agent's own order across a mix of advisory and blocking kinds", () => {
    const clarification = discovery({ kind: "clarification", title: "First" });
    const correction = discovery({ kind: "correction", title: "Second" });
    const prerequisite = discovery({ kind: "prerequisite", title: "Third" });

    assert.deepEqual(blockingDiscoveriesOf([clarification, correction, prerequisite]), [
      correction,
      prerequisite,
    ]);
  });
});

describe("routeRunDiscoveries", () => {
  it("answers undefined when the run filed nothing and dropped nothing", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());

    assert.equal(await routeRunDiscoveries(tracker, ticket, undefined), undefined);
    assert.equal(await routeRunDiscoveries(tracker, ticket, []), undefined);
    assert.equal(await routeRunDiscoveries(tracker, ticket, [], 0), undefined);
  });

  it("routes an implementation run's discoveries against its own ticket, naming no crossTarget", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());

    const routed = await routeRunDiscoveries(tracker, ticket, [discovery()]);

    assert.equal(routed?.target.number, ticket.number);
    assert.equal(routed?.crossTarget, undefined);
    assert.equal(routed?.routing.filed.length, 1);
  });

  it("routes a review run's discoveries against the implementation ticket it belongs to, naming it as crossTarget", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const review = await tracker.createReviewTicket(
      ticket,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );

    const routed = await routeRunDiscoveries(tracker, review, [
      discovery({ kind: "prerequisite" }),
    ]);

    assert.equal(routed?.target.number, ticket.number);
    assert.equal(routed?.crossTarget?.number, ticket.number);
    assert.equal(tracker.discoveredTickets[0]?.discoveredWhile.number, ticket.number);
  });

  it("carries a positive discoveriesDropped through onto the routing even when nothing was filed", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());

    const routed = await routeRunDiscoveries(tracker, ticket, [], 2);

    assert.equal(routed?.routing.discoveriesDropped, 2);
    assert.equal(routed?.routing.filed.length, 0);
  });

  it("never resolves a target for a pull request ticket that only dropped files, since nothing would be routed against it", async (t) => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());
    const review = await tracker.createReviewTicket(
      ticket,
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    );
    const listOpenIssues = t.mock.method(tracker, "listOpenIssues");

    const routed = await routeRunDiscoveries(tracker, review, [], 2);

    assert.equal(routed?.target.number, review.number);
    assert.equal(routed?.crossTarget, undefined);
    assert.equal(routed?.routing.discoveriesDropped, 2);
    assert.equal(listOpenIssues.mock.callCount(), 0);
  });

  it("carries discoveriesDropped through alongside filed discoveries", async () => {
    const tracker = new FakeIssueTracker();
    const ticket = tracker.addEligibleTicket(PILOT, implementation());

    const routed = await routeRunDiscoveries(tracker, ticket, [discovery()], 3);

    assert.equal(routed?.routing.discoveriesDropped, 3);
    assert.equal(routed?.routing.filed.length, 1);
  });

  it("refuses every discovery when a pull request ticket's implementation ticket cannot be found", async () => {
    const tracker = new FakeIssueTracker();
    // A review ticket built by hand, with no `parent` recorded — the shape a
    // truncated backlog would leave `listOpenIssues` reporting.
    const review = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(8),
      title: "Review #7",
      pullRequest: {
        kind: "review",
        url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
      },
    });

    const routed = await routeRunDiscoveries(tracker, review, [discovery()]);

    assert.equal(routed?.routing.filed.length, 0);
    assert.equal(routed?.routing.refused.length, 1);
    assert.match(routed?.routing.refused[0]?.reason ?? "", /could not find the implementation ticket/);
  });

  it("routes a spec review run's discoveries against the supertask it belongs to, naming it as crossTarget", async () => {
    const tracker = new FakeIssueTracker();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(66),
      title: "Too big for one run",
    });
    const specReview = await tracker.createSpecReviewTicket(supertask, "Review it.");

    const routed = await routeRunDiscoveries(tracker, specReview, [
      discovery({ kind: "prerequisite" }),
    ]);

    assert.equal(routed?.target.number, supertask.number);
    assert.equal(routed?.crossTarget?.number, supertask.number);
    assert.equal(tracker.discoveredTickets[0]?.discoveredWhile.number, supertask.number);
  });

  it("refuses every discovery when a spec review ticket's supertask cannot be found", async () => {
    const tracker = new FakeIssueTracker();
    // A spec review ticket built by hand, with no `parent` recorded — the
    // shape a truncated backlog would leave `listOpenIssues` reporting. Read
    // back through `listOpenIssues`, the way selection does, so it carries
    // `specReview: true` — `addSpecReviewTicket` hands back the raw stored
    // ticket, before that is folded in from its label.
    tracker.addSpecReviewTicket(PILOT, {
      number: issueNumber(52),
      title: "Review the loop spec",
    });
    const { issues } = await tracker.listOpenIssues(PILOT);
    const specReview = issues.find((issue) => issue.ticket.number === issueNumber(52))?.ticket;
    assert.ok(specReview !== undefined);

    const routed = await routeRunDiscoveries(tracker, specReview, [discovery()]);

    assert.equal(routed?.routing.filed.length, 0);
    assert.equal(routed?.routing.refused.length, 1);
    assert.match(routed?.routing.refused[0]?.reason ?? "", /could not find the supertask/);
  });
});

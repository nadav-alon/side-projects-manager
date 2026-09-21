import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  branch,
  isSpecReviewTicket,
  issueNumber,
  repoSlug,
  SPEC_REVIEW_SIZE_LABEL,
  type OpenIssues,
} from "./ports/index.ts";
import { specReviewSweep } from "./spec-review-sweep.ts";
import { FakeIssueTracker } from "./testing/fake-issue-tracker.ts";
import { FakeRepoHost } from "./testing/fake-repo-host.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("specReviewSweep", () => {
  it("opens a spec review for a supertask whose sub-issues have all closed", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
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
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.equal(outcome.opened.length, 1);
    assert.equal(isSpecReviewTicket(outcome.opened[0]!), true);
    assert.equal(tracker.specReviewTickets[0]?.parent.number, supertask.number);
    assert.equal(outcome.refusals.length, 0);
  });

  it("opens the spec review carrying ready-for-agent, spec-review and size:L", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
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
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const opened = outcome.opened[0]!;
    assert.equal(tracker.carriesLabel(opened, "ready-for-agent"), true);
    assert.equal(tracker.carriesLabel(opened, "spec-review"), true);
    assert.equal(tracker.carriesLabel(opened, SPEC_REVIEW_SIZE_LABEL), true);
  });

  it("does nothing for a supertask that still has an open sub-issue", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Still open",
      parent: supertask.number,
    });
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome.opened, []);
    assert.deepEqual(tracker.specReviewTickets, []);
  });

  it("does nothing for a supertask that has never had a sub-issue", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome.opened, []);
  });

  it("does nothing for a ticket with a closed sub-issue but no supertask label", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const spec = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(40),
      title: "A spec, unlabelled",
    });
    const child = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Part one",
      parent: spec.number,
    });
    tracker.closeOutOfBand(child);
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome.opened, []);
  });

  it("fires at most once per supertask, ever: a supertask that already has a spec review sub-issue, even closed, gets no other", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const priorSpecReview = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Spec review for #40",
      parent: supertask.number,
    });
    tracker.addLabel(priorSpecReview, "spec-review");
    tracker.closeOutOfBand(priorSpecReview);
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome.opened, []);
    assert.deepEqual(tracker.specReviewTickets, []);
  });

  it("gives each nested supertask its own spec review as its own sub-issues close", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const outer = tracker.addSupertask(PILOT, {
      number: issueNumber(10),
      title: "Outer supertask",
    });
    const inner = tracker.addSupertask(PILOT, {
      number: issueNumber(11),
      title: "Inner supertask",
      parent: outer.number,
    });
    const innerChild = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(12),
      title: "Inner part",
      parent: inner.number,
    });
    tracker.closeOutOfBand(innerChild);
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    // Only the inner supertask fires: the outer one still has an open
    // sub-issue — the inner supertask itself, still open.
    assert.equal(outcome.opened.length, 1);
    assert.equal(tracker.specReviewTickets[0]?.parent.number, inner.number);
  });

  it("names the supertask and every sub-issue in the body", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const first = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Part one",
      parent: supertask.number,
    });
    const second = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(42),
      title: "Part two",
      parent: supertask.number,
    });
    tracker.closeOutOfBand(first);
    tracker.closeOutOfBand(second);
    const openIssues = await tracker.listOpenIssues(PILOT);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /#40/);
    assert.match(body, /#41/);
    assert.match(body, /#42/);
  });

  it("names the branch and state of a sub-issue's unmerged pull request", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
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
    repoHost.setPullRequestsClosingIssues(PILOT, [
      {
        number: issueNumber(50),
        state: "closed",
        branch: branch("41-part-one"),
        closesIssues: [issueNumber(41)],
      },
    ]);
    const openIssues = await tracker.listOpenIssues(PILOT);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /#41.*#50.*41-part-one.*closed/);
  });

  it("says nothing about a sub-issue whose pull request merged", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
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
    repoHost.setPullRequestsClosingIssues(PILOT, [
      {
        number: issueNumber(50),
        state: "merged",
        branch: branch("41-part-one"),
        closesIssues: [issueNumber(41)],
      },
    ]);
    const openIssues = await tracker.listOpenIssues(PILOT);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.doesNotMatch(body, /50/);
    assert.doesNotMatch(body, /41-part-one/);
  });

  it("says nothing about a sub-issue with no pull request at all", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const supertask = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "Too big for one run",
    });
    const child = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Closed by hand",
      parent: supertask.number,
    });
    tracker.closeOutOfBand(child);
    const openIssues = await tracker.listOpenIssues(PILOT);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /^- #41\s*$/m);
  });

  it("records a refusal and carries on to the next supertask", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const first = tracker.addSupertask(PILOT, {
      number: issueNumber(40),
      title: "First supertask",
    });
    const firstChild = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(41),
      title: "Part one",
      parent: first.number,
    });
    tracker.closeOutOfBand(firstChild);
    const second = tracker.addSupertask(PILOT, {
      number: issueNumber(60),
      title: "Second supertask",
    });
    const secondChild = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(61),
      title: "Part one",
      parent: second.number,
    });
    tracker.closeOutOfBand(secondChild);
    const openIssues = await tracker.listOpenIssues(PILOT);

    const original = tracker.listSubIssues.bind(tracker);
    tracker.listSubIssues = async (ticket) => {
      if (ticket.number === first.number) {
        throw new Error("tracker unavailable");
      }
      return original(ticket);
    };

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(
      outcome.refusals.map((refusal) => refusal.supertask.number),
      [40],
    );
    assert.equal(outcome.refusals[0]?.error, "tracker unavailable");
    assert.equal(outcome.opened.length, 1);
    assert.equal(outcome.opened[0]?.number, 62);
  });

  it("answers with no opened tickets and no refusals for a project with no supertask", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Ordinary ticket" });
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome, { repo: PILOT, opened: [], refusals: [] });
  });

  it("answers with no opened tickets and no refusals for no open issues at all", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const openIssues: OpenIssues = { issues: [], truncated: false };

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome, { repo: PILOT, opened: [], refusals: [] });
  });
});

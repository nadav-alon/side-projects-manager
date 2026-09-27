import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  branch,
  isSpecReviewTicket,
  issueNumber,
  repoSlug,
  specReviewTitle,
  SPEC_REVIEW_SIZE_LABEL,
  type OpenIssues,
  type Ticket,
} from "./ports/index.ts";
import { specReviewSweep } from "./spec-review-sweep.ts";
import { FakeIssueTracker } from "./testing/fake-issue-tracker.ts";
import { FakeRepoHost } from "./testing/fake-repo-host.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const OTHER = repoSlug("nadav-alon/other");

/**
 * A fresh tracker and repo host, with a supertask (#40, "Too big for one
 * run") already carrying one closed sub-issue (#41, "Part one") in PILOT —
 * the preamble most tests below share, up to the point each one diverges on
 * what else it adds and what it goes on to assert. `openIssues` is read once
 * that sub-issue is closed; a test that closes further sub-issues of its own
 * before sweeping may still hand it to `specReviewSweep` unchanged, since
 * none of them were open in it to begin with.
 */
async function sweptSupertask(): Promise<{
  tracker: FakeIssueTracker;
  repoHost: FakeRepoHost;
  supertask: Ticket;
  openIssues: OpenIssues;
}> {
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
  return { tracker, repoHost, supertask, openIssues };
}

/**
 * A closed sub-issue of `supertask`, in `OTHER` rather than `PILOT`, numbered
 * the same as `supertask`'s own #41 — what the cross-repo tests below share
 * before each diverges on the pull requests it hands the sweep.
 */
function crossRepoSubIssue(tracker: FakeIssueTracker, supertask: Ticket): Ticket {
  const crossRepoChild = tracker.addEligibleTicket(OTHER, {
    number: issueNumber(41),
    title: "Same-numbered issue in another repo",
  });
  tracker.closeOutOfBand(crossRepoChild);
  tracker.linkSubIssue(supertask, crossRepoChild);
  return crossRepoChild;
}

describe("specReviewSweep", () => {
  it("opens a spec review for a supertask whose sub-issues have all closed", async () => {
    const { tracker, repoHost, supertask, openIssues } = await sweptSupertask();

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.equal(outcome.opened.length, 1);
    assert.equal(isSpecReviewTicket(outcome.opened[0]!), true);
    assert.equal(tracker.specReviewTickets[0]?.parent.number, supertask.number);
    assert.equal(outcome.refusals.length, 0);
  });

  it("opens the spec review carrying ready-for-agent, spec-review and size:L", async () => {
    const { tracker, repoHost, openIssues } = await sweptSupertask();

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

  it("recognises a spec review it already opened but never linked, and links it instead of opening a duplicate", async () => {
    const { tracker, repoHost, supertask } = await sweptSupertask();
    const floating = tracker.addSpecReviewTicket(PILOT, {
      number: issueNumber(99),
      title: specReviewTitle(supertask),
    });
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome.opened, []);
    assert.deepEqual(outcome.refusals, []);
    assert.deepEqual(tracker.specReviewTickets, []);
    assert.equal(tracker.linkedSpecReviewTickets.length, 1);
    assert.equal(tracker.linkedSpecReviewTickets[0]?.ticket.number, floating.number);
    assert.equal(tracker.linkedSpecReviewTickets[0]?.parent.number, supertask.number);
    assert.equal(outcome.linked.length, 1);
    assert.equal(outcome.linked[0]?.specReview.number, floating.number);
    assert.equal(outcome.linked[0]?.supertask.number, supertask.number);

    const subIssues = await tracker.listSubIssues(supertask);
    assert.equal(
      subIssues.some((sub) => sub.ticket.number === floating.number),
      true,
    );
  });

  it("opens a spec review rather than re-parenting one already linked elsewhere with a matching title", async () => {
    const { tracker, repoHost, supertask } = await sweptSupertask();
    const elsewhere = tracker.addSupertask(PILOT, {
      number: issueNumber(7),
      title: "Some other supertask",
    });
    tracker.addSpecReviewTicket(PILOT, {
      number: issueNumber(99),
      title: specReviewTitle(supertask),
      parent: elsewhere.number,
    });
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(tracker.linkedSpecReviewTickets, []);
    assert.equal(outcome.opened.length, 1);
    assert.equal(outcome.refusals.length, 0);
  });

  it("records an open refusal when creating a spec review fails", async () => {
    const { tracker, repoHost, supertask } = await sweptSupertask();
    tracker.createSpecReviewTicket = async () => {
      throw new Error("create refused");
    };

    const openIssues = await tracker.listOpenIssues(PILOT);
    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome.opened, []);
    assert.equal(outcome.refusals.length, 1);
    assert.equal(outcome.refusals[0]?.supertask.number, supertask.number);
    assert.equal(outcome.refusals[0]?.action, "open");
    assert.equal(outcome.refusals[0]?.error, "create refused");
  });

  it("records a refusal and opens no duplicate when linking an already-opened spec review fails", async () => {
    const { tracker, repoHost, supertask } = await sweptSupertask();
    tracker.addSpecReviewTicket(PILOT, {
      number: issueNumber(99),
      title: specReviewTitle(supertask),
    });
    const openIssues = await tracker.listOpenIssues(PILOT);
    tracker.linkSpecReviewTicket = async () => {
      throw new Error("link refused");
    };

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome.opened, []);
    assert.deepEqual(tracker.specReviewTickets, []);
    assert.deepEqual(outcome.linked, []);
    assert.equal(outcome.refusals.length, 1);
    assert.equal(outcome.refusals[0]?.supertask.number, supertask.number);
    assert.equal(outcome.refusals[0]?.action, "link");
    assert.equal(outcome.refusals[0]?.error, "link refused");
  });

  it("links the still-floating spec review on a later sweep once a prior link failure clears", async () => {
    const { tracker, repoHost, supertask } = await sweptSupertask();
    const floating = tracker.addSpecReviewTicket(PILOT, {
      number: issueNumber(99),
      title: specReviewTitle(supertask),
    });
    const failingOpenIssues = await tracker.listOpenIssues(PILOT);
    const realLink = tracker.linkSpecReviewTicket.bind(tracker);
    tracker.linkSpecReviewTicket = async () => {
      throw new Error("link refused");
    };
    const firstOutcome = await specReviewSweep(
      { tracker, repoHost },
      PILOT,
      failingOpenIssues,
    );
    assert.equal(firstOutcome.refusals.length, 1);
    assert.deepEqual(firstOutcome.opened, []);
    assert.deepEqual(firstOutcome.linked, []);

    tracker.linkSpecReviewTicket = realLink;
    const laterOpenIssues = await tracker.listOpenIssues(PILOT);

    const secondOutcome = await specReviewSweep(
      { tracker, repoHost },
      PILOT,
      laterOpenIssues,
    );

    assert.deepEqual(secondOutcome.opened, []);
    assert.deepEqual(secondOutcome.refusals, []);
    assert.deepEqual(tracker.specReviewTickets, []);
    assert.equal(tracker.linkedSpecReviewTickets.length, 1);
    assert.equal(tracker.linkedSpecReviewTickets[0]?.ticket.number, floating.number);
    assert.equal(secondOutcome.linked.length, 1);
    assert.equal(secondOutcome.linked[0]?.specReview.number, floating.number);
    assert.equal(secondOutcome.linked[0]?.supertask.number, supertask.number);
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

  it("gives the outer supertask its own spec review once the inner one, review included, is closed by hand", async () => {
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
    await specReviewSweep({ tracker, repoHost }, PILOT, await tracker.listOpenIssues(PILOT));

    // "Review included": both the inner supertask's own spec review and the
    // inner supertask itself close by hand, per `spec-review-sweep.ts`'s own
    // module doc.
    tracker.closeOutOfBand(tracker.specReviewTickets[0]!.ticket);
    tracker.closeOutOfBand(inner);
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.equal(outcome.opened.length, 1);
    assert.equal(tracker.specReviewTickets[1]?.parent.number, outer.number);
  });

  it("names the supertask and every sub-issue in the body", async () => {
    const { tracker, repoHost, supertask, openIssues } = await sweptSupertask();
    const second = tracker.addEligibleTicket(PILOT, {
      number: issueNumber(42),
      title: "Part two",
      parent: supertask.number,
    });
    tracker.closeOutOfBand(second);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /#40/);
    assert.match(body, /#41/);
    assert.match(body, /#42/);
  });

  it("names the branch and state of a sub-issue's unmerged pull request", async () => {
    const { tracker, repoHost, openIssues } = await sweptSupertask();
    repoHost.setPullRequestsClosingIssues(PILOT, [
      {
        number: issueNumber(50),
        state: "closed",
        branch: branch("41-part-one"),
        closesIssues: [{ repo: PILOT, number: issueNumber(41) }],
      },
    ]);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /#41.*#50.*41-part-one.*closed/);
  });

  it("says nothing about a sub-issue whose pull request merged", async () => {
    const { tracker, repoHost, openIssues } = await sweptSupertask();
    repoHost.setPullRequestsClosingIssues(PILOT, [
      {
        number: issueNumber(50),
        state: "merged",
        branch: branch("41-part-one"),
        closesIssues: [{ repo: PILOT, number: issueNumber(41) }],
      },
    ]);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.doesNotMatch(body, /50/);
    assert.doesNotMatch(body, /41-part-one/);
  });

  it("says nothing about a sub-issue with no pull request at all", async () => {
    const { tracker, repoHost, openIssues } = await sweptSupertask();

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /^- #41\s*$/m);
  });

  it("credits a same-repo sub-issue's pull request even where closesIssues names its repo in GitHub's own casing, not the configured slug's", async () => {
    const { tracker, repoHost, openIssues } = await sweptSupertask();
    repoHost.setPullRequestsClosingIssues(PILOT, [
      {
        number: issueNumber(50),
        state: "open",
        branch: branch("41-part-one"),
        closesIssues: [{ repo: repoSlug("Nadav-Alon/Pilot"), number: issueNumber(41) }],
      },
    ]);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /^- #41: pull request #50 on branch `41-part-one`, open\s*$/m);
  });

  it("names a sub-issue in another repo as owner/repo#N, not a bare number that would resolve against the supertask's own repo", async () => {
    const { tracker, repoHost, supertask, openIssues } = await sweptSupertask();
    crossRepoSubIssue(tracker, supertask);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /^- #41\s*$/m);
    assert.match(body, /^- nadav-alon\/other#41\s*$/m);
  });

  it("does not credit a cross-repo sub-issue with a pull request that closes a same-numbered issue in the supertask's own repo", async () => {
    const { tracker, repoHost, supertask, openIssues } = await sweptSupertask();
    crossRepoSubIssue(tracker, supertask);
    repoHost.setPullRequestsClosingIssues(PILOT, [
      {
        number: issueNumber(50),
        state: "open",
        branch: branch("41-part-one"),
        closesIssues: [{ repo: PILOT, number: issueNumber(41) }],
      },
    ]);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(body, /^- #41: pull request #50 on branch `41-part-one`, open\s*$/m);
    assert.match(body, /^- nadav-alon\/other#41\s*$/m);
  });

  it("credits a cross-repo sub-issue with a pull request that closes it in its own repo", async () => {
    const { tracker, repoHost, supertask, openIssues } = await sweptSupertask();
    crossRepoSubIssue(tracker, supertask);
    repoHost.setPullRequestsClosingIssues(PILOT, [
      {
        number: issueNumber(50),
        state: "open",
        branch: branch("41-part-one"),
        closesIssues: [{ repo: OTHER, number: issueNumber(41) }],
      },
    ]);

    await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    const body = tracker.specReviewTickets[0]?.body ?? "";
    assert.match(
      body,
      /^- nadav-alon\/other#41: pull request #50 on branch `41-part-one`, open\s*$/m,
    );
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
    assert.equal(outcome.refusals[0]?.action, "read");
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

    assert.deepEqual(outcome, { repo: PILOT, opened: [], linked: [], refusals: [] });
  });

  it("answers with no opened tickets and no refusals for no open issues at all", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    const openIssues: OpenIssues = { issues: [], truncated: false };

    const outcome = await specReviewSweep({ tracker, repoHost }, PILOT, openIssues);

    assert.deepEqual(outcome, { repo: PILOT, opened: [], linked: [], refusals: [] });
  });
});

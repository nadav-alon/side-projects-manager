import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { conflictSweep } from "./conflict-sweep.ts";
import {
  issueNumber,
  NEEDS_REBASE,
  pullRequestUrl,
  REBASE_COMMENT,
  REBASE_STATUS_RETRY_DELAY,
  repoSlug,
} from "./ports/index.ts";
import type { MergeStatus, Milliseconds, PullRequestUrl } from "./ports/index.ts";
import { FakeIssueTracker } from "./testing/fake-issue-tracker.ts";
import { FakeRepoHost } from "./testing/fake-repo-host.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const NO_OPEN_ISSUES = { issues: [], truncated: false };

const NO_WAIT = async () => {};

const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");
const OTHER_PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/8");
const THIRD_PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/9");

describe("conflictSweep", () => {
  it("never reads, labels or comments on a pull request whose body names no closed ticket", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [{ url: PULL_REQUEST, labels: [] }]);
    host.mergeStatus = () => "conflicting";
    const readMergeStatus = t.mock.method(host, "readMergeStatus");

    const outcome = await conflictSweep(host, PILOT, true, NO_OPEN_ISSUES);

    assert.equal(readMergeStatus.mock.callCount(), 0);
    assert.deepEqual(host.labelled, []);
    assert.deepEqual(host.comments, []);
    assert.deepEqual(outcome, { repo: PILOT, changes: [], refusals: [] });
  });

  it("labels a conflicting pull request that does not carry needs-rebase", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "conflicting";
    const readMergeStatus = t.mock.method(host, "readMergeStatus");

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.equal(readMergeStatus.mock.callCount(), 1);
    assert.deepEqual(host.labelled, [{ pullRequest: PULL_REQUEST, label: NEEDS_REBASE }]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: PULL_REQUEST, action: "labelled" },
    ]);
    assert.deepEqual(outcome.refusals, []);
  });

  it("does not label a conflicting pull request that already carries needs-rebase", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "conflicting";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(host.labelled, []);
    assert.deepEqual(outcome.changes, []);
  });

  it("leaves a pull request still unknown after re-reads untouched but names it", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "unknown";

    const outcome = await conflictSweep(host, PILOT, true, NO_OPEN_ISSUES, new Set(), NO_WAIT);

    assert.deepEqual(host.labelled, []);
    assert.deepEqual(host.comments, []);
    assert.deepEqual(outcome, {
      repo: PILOT,
      changes: [],
      refusals: [
        {
          action: "unsettled",
          pullRequest: PULL_REQUEST,
          error: "mergeability still unknown after 3 reads",
        },
      ],
    });
  });

  it("re-reads an unknown pull request and acts on the settled answer", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    const answers: MergeStatus[] = ["unknown", "conflicting"];
    t.mock.method(host, "readMergeStatus", async () => answers.shift() ?? "unknown");

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES, new Set(), NO_WAIT);

    assert.deepEqual(host.labelled, [{ pullRequest: PULL_REQUEST, label: NEEDS_REBASE }]);
    assert.deepEqual(outcome.changes, [{ pullRequest: PULL_REQUEST, action: "labelled" }]);
  });

  it("waits REBASE_STATUS_RETRY_DELAY before each re-read of an unknown pull request", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "unknown";
    const waits: Milliseconds[] = [];

    await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES, new Set(), async (delay) => {
      waits.push(delay);
    });

    assert.deepEqual(waits, [REBASE_STATUS_RETRY_DELAY, REBASE_STATUS_RETRY_DELAY]);
  });

  it("records a refused mergeability read and carries on to the next pull request", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      { url: OTHER_PULL_REQUEST, labels: [], closes: issueNumber(2) },
    ]);
    host.mergeStatus = () => "conflicting";
    t.mock.method(host, "readMergeStatus", async (pullRequest: PullRequestUrl) => {
      if (pullRequest === PULL_REQUEST) {
        throw new Error("mergeability check refused");
      }
      return "conflicting";
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome.refusals, [
      { action: "read", pullRequest: PULL_REQUEST, error: "mergeability check refused" },
    ]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: OTHER_PULL_REQUEST, action: "labelled" },
    ]);
  });

  it("records a refused label and carries on to the next pull request", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      { url: OTHER_PULL_REQUEST, labels: [], closes: issueNumber(2) },
    ]);
    host.mergeStatus = () => "conflicting";
    t.mock.method(host, "labelPullRequest", async (pullRequest: PullRequestUrl) => {
      if (pullRequest === PULL_REQUEST) {
        throw new Error("label does not exist");
      }
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome.refusals, [
      { action: "label", pullRequest: PULL_REQUEST, error: "label does not exist" },
    ]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: OTHER_PULL_REQUEST, action: "labelled" },
    ]);
  });

  it("removes needs-rebase from a clean pull request that carries it", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
    ]);
    host.labelNeedsRebase(PULL_REQUEST);
    host.mergeStatus = () => "clean";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.equal(host.hasNeedsRebaseLabel(PULL_REQUEST), false);
    assert.deepEqual(outcome.changes, [
      { pullRequest: PULL_REQUEST, action: "unlabelled" },
    ]);
    assert.deepEqual(outcome.refusals, []);
  });

  it("removes needs-rebase from a clean pull request even while a rebase ticket for it is open", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
    ]);
    host.labelNeedsRebase(PULL_REQUEST);
    host.mergeStatus = () => "clean";
    const tracker = new FakeIssueTracker();
    tracker.addEligibleTicket(PILOT, {
      number: issueNumber(2),
      title: "Rebase #1",
      pullRequest: { kind: "rebase", url: PULL_REQUEST },
    });
    const openIssues = await tracker.listOpenIssues(PILOT);

    const outcome = await conflictSweep(host, PILOT, false, openIssues);

    assert.equal(host.hasNeedsRebaseLabel(PULL_REQUEST), false);
    assert.deepEqual(outcome.changes, [
      { pullRequest: PULL_REQUEST, action: "unlabelled" },
    ]);
  });

  it("does nothing to a clean pull request that does not carry needs-rebase", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "clean";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome, { repo: PILOT, changes: [], refusals: [] });
  });

  it("records a refused unlabel and carries on to the next pull request", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
      { url: OTHER_PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(2) },
    ]);
    host.mergeStatus = () => "clean";
    t.mock.method(host, "removeNeedsRebaseLabel", async (pullRequest: PullRequestUrl) => {
      if (pullRequest === PULL_REQUEST) {
        throw new Error("label already gone");
      }
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome.refusals, [
      { action: "unlabel", pullRequest: PULL_REQUEST, error: "label already gone" },
    ]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: OTHER_PULL_REQUEST, action: "unlabelled" },
    ]);
  });

  describe("turbo", () => {
    it("posts /rebase on a conflicting pull request with no open rebase ticket", async () => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      host.mergeStatus = () => "conflicting";

      const outcome = await conflictSweep(host, PILOT, true, NO_OPEN_ISSUES);

      assert.deepEqual(host.comments, [
        { pullRequest: PULL_REQUEST, body: REBASE_COMMENT },
      ]);
      assert.deepEqual(outcome.changes, [
        { pullRequest: PULL_REQUEST, action: "labelled" },
        { pullRequest: PULL_REQUEST, action: "commented" },
      ]);
    });

    it("posts /rebase on a conflicting pull request that already carries needs-rebase", async () => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
      ]);
      host.mergeStatus = () => "conflicting";

      const outcome = await conflictSweep(host, PILOT, true, NO_OPEN_ISSUES);

      assert.deepEqual(host.comments, [
        { pullRequest: PULL_REQUEST, body: REBASE_COMMENT },
      ]);
      assert.deepEqual(outcome.changes, [
        { pullRequest: PULL_REQUEST, action: "commented" },
      ]);
    });

    it("never posts /rebase in a project that is not turbo", async () => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      host.mergeStatus = () => "conflicting";

      const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

      assert.deepEqual(host.comments, []);
      assert.deepEqual(outcome.changes, [
        { pullRequest: PULL_REQUEST, action: "labelled" },
      ]);
    });

    it("posts nothing while an open rebase ticket is eligible for the pull request", async () => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      host.mergeStatus = () => "conflicting";
      const tracker = new FakeIssueTracker();
      tracker.addEligibleTicket(PILOT, {
        number: issueNumber(2),
        title: "Rebase #1",
        pullRequest: { kind: "rebase", url: PULL_REQUEST },
      });
      const openIssues = await tracker.listOpenIssues(PILOT);

      const outcome = await conflictSweep(host, PILOT, true, openIssues);

      assert.deepEqual(host.comments, []);
      assert.equal(
        outcome.changes.some((change) => change.action === "commented"),
        false,
      );
    });

    it("posts nothing while pendingRebasePosts already names the pull request", async () => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      host.mergeStatus = () => "conflicting";

      const outcome = await conflictSweep(
        host,
        PILOT,
        true,
        NO_OPEN_ISSUES,
        new Set([PULL_REQUEST]),
      );

      assert.deepEqual(host.comments, []);
      assert.equal(
        outcome.changes.some((change) => change.action === "commented"),
        false,
      );
    });

    it("posts nothing while the open rebase ticket was handed back to the developer", async () => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      host.mergeStatus = () => "conflicting";
      const tracker = new FakeIssueTracker();
      tracker.addIneligibleTicket(PILOT, {
        number: issueNumber(2),
        title: "Rebase #1",
        pullRequest: { kind: "rebase", url: PULL_REQUEST },
      });
      const openIssues = await tracker.listOpenIssues(PILOT);

      const outcome = await conflictSweep(host, PILOT, true, openIssues);

      assert.deepEqual(host.comments, []);
      assert.equal(
        outcome.changes.some((change) => change.action === "commented"),
        false,
      );
    });

    it("posts /rebase on each of three conflicting pull requests, with no cap", async () => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
        { url: OTHER_PULL_REQUEST, labels: [], closes: issueNumber(2) },
        { url: THIRD_PULL_REQUEST, labels: [], closes: issueNumber(3) },
      ]);
      host.mergeStatus = () => "conflicting";

      const outcome = await conflictSweep(host, PILOT, true, NO_OPEN_ISSUES);

      assert.deepEqual(
        host.comments.map((comment) => comment.pullRequest),
        [PULL_REQUEST, OTHER_PULL_REQUEST, THIRD_PULL_REQUEST],
      );
      assert.deepEqual(
        outcome.changes.filter((change) => change.action === "commented"),
        [
          { pullRequest: PULL_REQUEST, action: "commented" },
          { pullRequest: OTHER_PULL_REQUEST, action: "commented" },
          { pullRequest: THIRD_PULL_REQUEST, action: "commented" },
        ],
      );
    });

    it("posts /rebase even when labelling the pull request was refused", async (t) => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      host.mergeStatus = () => "conflicting";
      t.mock.method(host, "labelPullRequest", async () => {
        throw new Error("label does not exist");
      });

      const outcome = await conflictSweep(host, PILOT, true, NO_OPEN_ISSUES);

      assert.deepEqual(host.comments, [
        { pullRequest: PULL_REQUEST, body: REBASE_COMMENT },
      ]);
      assert.deepEqual(
        outcome.refusals.find((refusal) => refusal.action === "label"),
        { action: "label", pullRequest: PULL_REQUEST, error: "label does not exist" },
      );
      assert.deepEqual(
        outcome.changes.find((change) => change.action === "commented"),
        { pullRequest: PULL_REQUEST, action: "commented" },
      );
    });

    it("records a refused comment and carries on to the next pull request", async (t) => {
      const host = new FakeRepoHost();
      host.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
        { url: OTHER_PULL_REQUEST, labels: [], closes: issueNumber(2) },
      ]);
      host.mergeStatus = () => "conflicting";
      t.mock.method(host, "postComment", async (pullRequest: PullRequestUrl) => {
        if (pullRequest === PULL_REQUEST) {
          throw new Error("comment refused");
        }
      });

      const outcome = await conflictSweep(host, PILOT, true, NO_OPEN_ISSUES);

      assert.deepEqual(
        outcome.refusals.filter((refusal) => refusal.action === "comment"),
        [{ action: "comment", pullRequest: PULL_REQUEST, error: "comment refused" }],
      );
      assert.deepEqual(
        outcome.changes.filter((change) => change.action === "commented"),
        [{ pullRequest: OTHER_PULL_REQUEST, action: "commented" }],
      );
    });
  });

  it("ends the project's sweep on a refused listing, without a per-pull-request refusal", async (t) => {
    const host = new FakeRepoHost();
    t.mock.method(host, "listOpenPullRequests", async () => {
      throw new Error("listing refused");
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome, {
      repo: PILOT,
      changes: [],
      refusals: [{ action: "list", error: "listing refused" }],
    });
  });
});

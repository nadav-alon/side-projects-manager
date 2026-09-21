import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLIED_REVIEW_LABEL,
  APPLY_REVIEW_COMMENT,
  issueNumber,
  MergeabilityUnknown,
  pullRequestUrl,
  repoSlug,
  REVIEWED_LABEL,
  type MergeStatus,
} from "../ports/index.ts";
import { FakeRepoHost } from "./fake-repo-host.ts";

const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");
const OTHER = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/8");
const SINCE = new Date("2026-09-15T00:00:00Z");
const AFTER = new Date("2026-09-15T01:00:00Z");
const PILOT = repoSlug("nadav-alon/pilot");

describe("FakeRepoHost apply-review answers", () => {
  it("answers from the threads a test opened, answered and resolved", async () => {
    const host = new FakeRepoHost();
    const applied = host.openApplyReviewThread(PULL_REQUEST);
    const declined = host.openApplyReviewThread(PULL_REQUEST);
    host.openApplyReviewThread(PULL_REQUEST);

    host.answerApplyReviewThread(PULL_REQUEST, applied, "applied", "abc123: brand the id", AFTER);
    host.resolveApplyReviewThread(PULL_REQUEST, applied);
    host.answerApplyReviewThread(PULL_REQUEST, declined, "declined", "out of scope", AFTER);

    const answers = await host.readApplyReviewAnswers(PULL_REQUEST, SINCE);

    assert.deepEqual(answers, { appliedSince: 1, declinedSince: 1, unanswered: 1 });
  });

  it("keeps each pull request's threads to itself", async () => {
    const host = new FakeRepoHost();
    host.openApplyReviewThread(OTHER);

    const answers = await host.readApplyReviewAnswers(PULL_REQUEST, SINCE);

    assert.deepEqual(answers, { appliedSince: 0, declinedSince: 0, unanswered: 0 });
  });

  it("refuses a thread index no test opened", () => {
    const host = new FakeRepoHost();

    assert.throws(
      () => host.commentOnApplyReviewThread(PULL_REQUEST, 0, "Hello.", AFTER),
      /No apply-review thread 0/,
    );
  });

  it("marks a pull request ready and records it", async () => {
    const host = new FakeRepoHost();

    await host.markPullRequestReady(PULL_REQUEST);

    assert.deepEqual(host.readyMarked, [PULL_REQUEST]);
  });

  it("records every label added, in order", async () => {
    const host = new FakeRepoHost();

    await host.labelPullRequest(PULL_REQUEST, REVIEWED_LABEL);
    await host.labelPullRequest(OTHER, APPLIED_REVIEW_LABEL);

    assert.deepEqual(host.labelled, [
      { pullRequest: PULL_REQUEST, label: REVIEWED_LABEL },
      { pullRequest: OTHER, label: APPLIED_REVIEW_LABEL },
    ]);
  });

  it("records every comment posted, in order", async () => {
    const host = new FakeRepoHost();

    await host.postComment(PULL_REQUEST, APPLY_REVIEW_COMMENT);
    await host.postComment(OTHER, "Hello.");

    assert.deepEqual(host.comments, [
      { pullRequest: PULL_REQUEST, body: APPLY_REVIEW_COMMENT },
      { pullRequest: OTHER, body: "Hello." },
    ]);
  });
});

describe("FakeRepoHost needsRebase", () => {
  it("says a clean pull request does not need a rebase, by default", async () => {
    const host = new FakeRepoHost();

    assert.equal(await host.needsRebase(PULL_REQUEST), false);
  });

  it("says a conflicting pull request needs a rebase", async () => {
    const host = new FakeRepoHost();
    host.mergeStatus = () => "conflicting";

    assert.equal(await host.needsRebase(PULL_REQUEST), true);
  });

  it("retries a pull request that answers unknown before it settles", async () => {
    const host = new FakeRepoHost();
    const answers: MergeStatus[] = ["unknown", "unknown", "conflicting"];
    host.mergeStatus = () => answers.shift() ?? "conflicting";

    assert.equal(await host.needsRebase(PULL_REQUEST), true);
  });

  it("throws, naming the pull request, once an unknown pull request exhausts its retries", async () => {
    const host = new FakeRepoHost();
    host.mergeStatus = () => "unknown";

    await assert.rejects(host.needsRebase(PULL_REQUEST), (error: unknown) => {
      assert.ok(error instanceof MergeabilityUnknown);
      assert.equal(error.pullRequest, PULL_REQUEST);
      return true;
    });
  });
});

describe("FakeRepoHost readMergeStatus", () => {
  it("answers clean by default", async () => {
    const host = new FakeRepoHost();

    assert.equal(await host.readMergeStatus(PULL_REQUEST), "clean");
  });

  it("answers with what mergeStatus is scripted to say", async () => {
    const host = new FakeRepoHost();
    host.mergeStatus = () => "conflicting";

    assert.equal(await host.readMergeStatus(PULL_REQUEST), "conflicting");
  });

  it("returns unknown as-is, without retrying", async () => {
    const host = new FakeRepoHost();
    let calls = 0;
    host.mergeStatus = () => {
      calls++;
      return "unknown";
    };

    assert.equal(await host.readMergeStatus(PULL_REQUEST), "unknown");
    assert.equal(calls, 1);
  });
});

describe("FakeRepoHost needs-rebase label", () => {
  it("does not carry the label by default", () => {
    const host = new FakeRepoHost();

    assert.equal(host.hasNeedsRebaseLabel(PULL_REQUEST), false);
  });

  it("carries the label once a test labels the pull request", () => {
    const host = new FakeRepoHost();

    host.labelNeedsRebase(PULL_REQUEST);

    assert.equal(host.hasNeedsRebaseLabel(PULL_REQUEST), true);
  });

  it("no longer carries the label once removed", async () => {
    const host = new FakeRepoHost();
    host.labelNeedsRebase(PULL_REQUEST);

    await host.removeNeedsRebaseLabel(PULL_REQUEST);

    assert.equal(host.hasNeedsRebaseLabel(PULL_REQUEST), false);
  });

  it("removes without error from a pull request never labelled", async () => {
    const host = new FakeRepoHost();

    await host.removeNeedsRebaseLabel(PULL_REQUEST);

    assert.equal(host.hasNeedsRebaseLabel(PULL_REQUEST), false);
  });

  it("keeps each pull request's label to itself", () => {
    const host = new FakeRepoHost();

    host.labelNeedsRebase(PULL_REQUEST);

    assert.equal(host.hasNeedsRebaseLabel(OTHER), false);
  });
});

describe("FakeRepoHost listOpenPullRequests", () => {
  it("answers with none for a repo no test scripted", async () => {
    const host = new FakeRepoHost();

    assert.deepEqual(await host.listOpenPullRequests(PILOT), []);
  });

  it("answers with what a test scripted, url, labels, closed ticket and all", async () => {
    const host = new FakeRepoHost();
    const scripted = [
      { url: PULL_REQUEST, labels: [REVIEWED_LABEL], closes: issueNumber(12) },
      { url: OTHER, labels: [] },
    ];
    host.setOpenPullRequests(PILOT, scripted);

    assert.deepEqual(await host.listOpenPullRequests(PILOT), scripted);
  });

  it("keeps each repo's open pull requests to itself", async () => {
    const host = new FakeRepoHost();
    const other = repoSlug("nadav-alon/other");
    host.setOpenPullRequests(other, [{ url: PULL_REQUEST, labels: [] }]);

    assert.deepEqual(await host.listOpenPullRequests(PILOT), []);
  });
});

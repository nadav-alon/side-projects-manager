import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pullRequestUrl } from "../ports/index.ts";
import { FakeRepoHost } from "./fake-repo-host.ts";

const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");
const OTHER = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/8");
const SINCE = new Date("2026-09-15T00:00:00Z");
const AFTER = new Date("2026-09-15T01:00:00Z");

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
});

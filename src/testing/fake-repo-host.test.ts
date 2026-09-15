import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pullRequestUrl } from "../ports/index.ts";
import { FakeRepoHost } from "./fake-repo-host.ts";

const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");
const SINCE = new Date("2026-09-15T00:00:00Z");
const AFTER = new Date("2026-09-15T01:00:00Z");

describe("FakeRepoHost apply-review answers", () => {
  it("reads a pull request with every thread answered as zero unanswered, with the applied and declined counts", async () => {
    const host = new FakeRepoHost();
    const first = host.openApplyReviewThread(PULL_REQUEST);
    const second = host.openApplyReviewThread(PULL_REQUEST);
    const third = host.openApplyReviewThread(PULL_REQUEST);

    host.answerApplyReviewThread(PULL_REQUEST, first, "applied", "abc123: brand the id", AFTER);
    host.answerApplyReviewThread(PULL_REQUEST, second, "applied", "def456: fix the guard", AFTER);
    host.answerApplyReviewThread(PULL_REQUEST, third, "declined", "out of scope", AFTER);

    const answers = await host.readApplyReviewAnswers(PULL_REQUEST, SINCE);

    assert.deepEqual(answers, { appliedSince: 2, declinedSince: 1, unanswered: 0 });
  });

  it("reads a thread with no marked reply as unanswered", async () => {
    const host = new FakeRepoHost();
    host.openApplyReviewThread(PULL_REQUEST);

    const answers = await host.readApplyReviewAnswers(PULL_REQUEST, SINCE);

    assert.deepEqual(answers, { appliedSince: 0, declinedSince: 0, unanswered: 1 });
  });

  it("reads a thread whose last comment came after the marked reply as unanswered", async () => {
    const host = new FakeRepoHost();
    const thread = host.openApplyReviewThread(PULL_REQUEST);
    host.answerApplyReviewThread(PULL_REQUEST, thread, "applied", "abc123: brand the id", AFTER);

    host.commentOnApplyReviewThread(
      PULL_REQUEST,
      thread,
      "Actually, one more thing.",
      new Date("2026-09-15T02:00:00Z"),
    );

    const answers = await host.readApplyReviewAnswers(PULL_REQUEST, SINCE);

    assert.deepEqual(answers, { appliedSince: 1, declinedSince: 0, unanswered: 1 });
  });

  it("marks a pull request ready and records it", async () => {
    const host = new FakeRepoHost();

    await host.markPullRequestReady(PULL_REQUEST);

    assert.deepEqual(host.readyMarked, [PULL_REQUEST]);
  });
});

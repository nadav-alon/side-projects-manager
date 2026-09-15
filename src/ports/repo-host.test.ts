import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLIED_REPLY_PREFIX,
  APPLY_REVIEW_MARKER,
  DECLINED_REPLY_PREFIX,
  summarizeApplyReviewThreads,
  type ApplyReviewThread,
} from "./repo-host.ts";

const SINCE = new Date("2026-09-15T00:00:00Z");
const AFTER = new Date("2026-09-15T01:00:00Z");
const BEFORE = new Date("2026-09-14T00:00:00Z");

function opened(at = AFTER): ApplyReviewThread {
  return { comments: [{ body: "Please fix this.", postedAt: at }] };
}

function applied(detail: string, at = AFTER): ApplyReviewThread {
  return {
    comments: [
      { body: "Please fix this.", postedAt: BEFORE },
      {
        body: `${APPLIED_REPLY_PREFIX}${detail}\n${APPLY_REVIEW_MARKER}`,
        postedAt: at,
      },
    ],
  };
}

function declined(reason: string, at = AFTER): ApplyReviewThread {
  return {
    comments: [
      { body: "Please fix this.", postedAt: BEFORE },
      {
        body: `${DECLINED_REPLY_PREFIX}${reason}\n${APPLY_REVIEW_MARKER}`,
        postedAt: at,
      },
    ],
  };
}

describe("summarizeApplyReviewThreads", () => {
  it("reads a pull request with every thread answered as zero unanswered, with the applied and declined counts", () => {
    const answers = summarizeApplyReviewThreads(
      [applied("abc123: brand the id"), applied("def456: fix the guard"), declined("out of scope")],
      SINCE,
    );

    assert.deepEqual(answers, { applied: 2, declined: 1, unanswered: 0 });
  });

  it("reads a thread with no marked reply as unanswered", () => {
    const answers = summarizeApplyReviewThreads([opened()], SINCE);

    assert.deepEqual(answers, { applied: 0, declined: 0, unanswered: 1 });
  });

  it("reads a thread whose last comment came after the marked reply as unanswered", () => {
    const reopened: ApplyReviewThread = {
      comments: [
        ...applied("abc123: brand the id").comments,
        { body: "Actually, one more thing.", postedAt: new Date("2026-09-15T02:00:00Z") },
      ],
    };

    const answers = summarizeApplyReviewThreads([reopened], SINCE);

    assert.deepEqual(answers, { applied: 0, declined: 0, unanswered: 1 });
  });

  it("does not count a marked reply posted before the read's instant as applied or declined", () => {
    const answers = summarizeApplyReviewThreads([applied("abc123: old pass", BEFORE)], SINCE);

    assert.deepEqual(answers, { applied: 0, declined: 0, unanswered: 0 });
  });
});

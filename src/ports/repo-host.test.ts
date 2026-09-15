import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLIED_REPLY_PREFIX,
  APPLY_REVIEW_MARKER,
  DECLINED_REPLY_PREFIX,
  summarizeApplyReviewThreads,
  type ApplyReviewComment,
  type ApplyReviewThread,
} from "./repo-host.ts";

const SINCE = new Date("2026-09-15T00:00:00Z");
const AFTER = new Date("2026-09-15T01:00:00Z");
const LATER = new Date("2026-09-15T02:00:00Z");
const BEFORE = new Date("2026-09-14T00:00:00Z");

const ASKED: ApplyReviewComment = { body: "Please fix this.", postedAt: BEFORE };

function marked(body: string, at = AFTER): ApplyReviewComment {
  return { body: `${body}\n${APPLY_REVIEW_MARKER}`, postedAt: at };
}

function opened(at = AFTER): ApplyReviewThread {
  return { resolved: false, comments: [{ body: "Please fix this.", postedAt: at }] };
}

function applied(detail: string, at = AFTER): ApplyReviewThread {
  return {
    resolved: false,
    comments: [ASKED, marked(`${APPLIED_REPLY_PREFIX}${detail}`, at)],
  };
}

function declined(reason: string, at = AFTER): ApplyReviewThread {
  return {
    resolved: false,
    comments: [ASKED, marked(`${DECLINED_REPLY_PREFIX}${reason}`, at)],
  };
}

describe("summarizeApplyReviewThreads", () => {
  it("reads a pull request with every thread answered as zero unanswered, with the applied and declined counts", () => {
    const answers = summarizeApplyReviewThreads(
      [applied("abc123: brand the id"), applied("def456: fix the guard"), declined("out of scope")],
      SINCE,
    );

    assert.deepEqual(answers, { appliedSince: 2, declinedSince: 1, unanswered: 0 });
  });

  it("reads a thread with no marked reply as unanswered", () => {
    const answers = summarizeApplyReviewThreads([opened()], SINCE);

    assert.deepEqual(answers, { appliedSince: 0, declinedSince: 0, unanswered: 1 });
  });

  it("reads a thread whose last comment came after the marked reply as unanswered, still counting the reply", () => {
    const reopened: ApplyReviewThread = {
      resolved: false,
      comments: [
        ...applied("abc123: brand the id").comments,
        { body: "Actually, one more thing.", postedAt: LATER },
      ],
    };

    const answers = summarizeApplyReviewThreads([reopened], SINCE);

    assert.deepEqual(answers, { appliedSince: 1, declinedSince: 0, unanswered: 1 });
  });

  it("counts the applied reply on a thread resolved after it, which is not unanswered", () => {
    const answers = summarizeApplyReviewThreads(
      [{ ...applied("abc123: brand the id"), resolved: true }],
      SINCE,
    );

    assert.deepEqual(answers, { appliedSince: 1, declinedSince: 0, unanswered: 0 });
  });

  it("does not read a resolved thread nobody answered as unanswered", () => {
    const answers = summarizeApplyReviewThreads([{ ...opened(), resolved: true }], SINCE);

    assert.deepEqual(answers, { appliedSince: 0, declinedSince: 0, unanswered: 0 });
  });

  it("counts every marked reply since the instant, not only a thread's last", () => {
    const answeredTwice: ApplyReviewThread = {
      resolved: false,
      comments: [
        ASKED,
        marked(`${DECLINED_REPLY_PREFIX}out of scope`),
        { body: "It is in scope: see the ticket.", postedAt: AFTER },
        marked(`${APPLIED_REPLY_PREFIX}abc123: brand the id`, LATER),
      ],
    };

    const answers = summarizeApplyReviewThreads([answeredTwice], SINCE);

    assert.deepEqual(answers, { appliedSince: 1, declinedSince: 1, unanswered: 0 });
  });

  it("reads a reply that opens with a quote by the verdict line after it", () => {
    const quoted: ApplyReviewThread = {
      resolved: false,
      comments: [
        ASKED,
        marked(`> Please fix this.\n\n${DECLINED_REPLY_PREFIX}out of scope`),
      ],
    };

    const answers = summarizeApplyReviewThreads([quoted], SINCE);

    assert.deepEqual(answers, { appliedSince: 0, declinedSince: 1, unanswered: 0 });
  });

  it("does not count a marked reply posted before the read's instant as applied or declined", () => {
    const answers = summarizeApplyReviewThreads([applied("abc123: old pass", BEFORE)], SINCE);

    assert.deepEqual(answers, { appliedSince: 0, declinedSince: 0, unanswered: 0 });
  });
});

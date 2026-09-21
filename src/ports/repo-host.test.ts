import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLIED_REPLY_PREFIX,
  APPLY_REVIEW_MARKER,
  closedTicketIn,
  DECLINED_REPLY_PREFIX,
  MergeabilityUnknown,
  REBASE_STATUS_ATTEMPTS,
  REBASE_STATUS_RETRY_DELAY,
  resolveNeedsRebase,
  REVIEW_FINDING_FIELDS,
  reviewFindingTemplate,
  summarizeApplyReviewThreads,
  type ApplyReviewComment,
  type ApplyReviewThread,
  type MergeStatus,
} from "./repo-host.ts";
import { issueNumber } from "./issue-number.ts";
import type { Milliseconds } from "./milliseconds.ts";
import { pullRequestUrl } from "./pull-request-url.ts";

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

describe("resolveNeedsRebase", () => {
  const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");

  /** No delay: what every test but the one on waiting itself hands `resolveNeedsRebase`. */
  const NO_WAIT = async () => {};

  /** A `read` that answers `statuses` in order, then repeats the last. */
  function reading(...statuses: MergeStatus[]): () => Promise<MergeStatus> {
    let calls = 0;
    return async () => statuses[Math.min(calls++, statuses.length - 1)]!;
  }

  it("says a conflicting pull request needs a rebase", async () => {
    const needsRebase = await resolveNeedsRebase(PULL_REQUEST, reading("conflicting"), NO_WAIT);

    assert.equal(needsRebase, true);
  });

  it("says a clean pull request does not need a rebase", async () => {
    const needsRebase = await resolveNeedsRebase(PULL_REQUEST, reading("clean"), NO_WAIT);

    assert.equal(needsRebase, false);
  });

  it("retries an unknown read until it settles, rather than answering on the first try", async () => {
    const needsRebase = await resolveNeedsRebase(
      PULL_REQUEST,
      reading("unknown", "unknown", "conflicting"),
      NO_WAIT,
    );

    assert.equal(needsRebase, true);
  });

  it("never answers false for a read that stays unknown, throwing carrying the pull request and what the host last said instead", async () => {
    await assert.rejects(
      resolveNeedsRebase(PULL_REQUEST, reading("unknown"), NO_WAIT),
      (error: unknown) => {
        assert.ok(error instanceof MergeabilityUnknown);
        assert.equal(error.pullRequest, PULL_REQUEST);
        assert.equal(error.lastStatus, "unknown");
        return true;
      },
    );
  });

  it("stops retrying after the bounded number of tries", async () => {
    let calls = 0;
    const read = async (): Promise<MergeStatus> => {
      calls++;
      return "unknown";
    };

    await assert.rejects(resolveNeedsRebase(PULL_REQUEST, read, NO_WAIT));

    assert.equal(calls, REBASE_STATUS_ATTEMPTS);
  });

  it("waits between one read and the next, but not before the first", async () => {
    const waits: Milliseconds[] = [];
    const wait = async (delay: Milliseconds) => {
      waits.push(delay);
    };

    await resolveNeedsRebase(
      PULL_REQUEST,
      reading("unknown", "unknown", "conflicting"),
      wait,
    );

    assert.deepEqual(waits, [REBASE_STATUS_RETRY_DELAY, REBASE_STATUS_RETRY_DELAY]);
  });
});

describe("reviewFindingTemplate", () => {
  it("renders path, line and body as their own placeholders, in that order", () => {
    assert.equal(
      reviewFindingTemplate(),
      '{"path": <path>, "line": <line>, "body": <body>}',
    );
  });

  it("names exactly the fields REVIEW_FINDING_FIELDS declares", () => {
    assert.deepEqual(REVIEW_FINDING_FIELDS, ["path", "line", "body"]);
  });
});

describe("closedTicketIn", () => {
  it("reads Closes #12", () => {
    assert.equal(closedTicketIn("Closes #12"), issueNumber(12));
  });

  it("reads fixes: #12, with its optional colon", () => {
    assert.equal(closedTicketIn("fixes: #12"), issueNumber(12));
  });

  it("reads RESOLVED #12, case-insensitively", () => {
    assert.equal(closedTicketIn("RESOLVED #12"), issueNumber(12));
  });

  it("does not read #12 alone, with no closing keyword", () => {
    assert.equal(closedTicketIn("#12"), undefined);
  });

  it("does not read preclose #12, whose keyword doesn't start at a word boundary", () => {
    assert.equal(closedTicketIn("preclose #12"), undefined);
  });

  it("reads the first match when a body names more than one", () => {
    assert.equal(
      closedTicketIn("Closes #12. Also fixes #34."),
      issueNumber(12),
    );
  });

  it("reads a keyword in the middle of a longer body", () => {
    assert.equal(
      closedTicketIn("Some context first.\n\nCloses #7.\n\nMore text."),
      issueNumber(7),
    );
  });

  it("does not pair a keyword on one line with a # on the next", () => {
    assert.equal(closedTicketIn("Closes\n#12"), undefined);
  });

  it("reads Closes\\r#12, the way grep's [[:space:]] would within one line", () => {
    assert.equal(closedTicketIn("Closes\r#12"), issueNumber(12));
  });

  it("reads every one of GitHub's nine closing keywords", () => {
    for (const keyword of [
      "close",
      "closes",
      "closed",
      "fix",
      "fixes",
      "fixed",
      "resolve",
      "resolves",
      "resolved",
    ]) {
      assert.equal(
        closedTicketIn(`${keyword} #5`),
        issueNumber(5),
        `expected "${keyword} #5" to close #5`,
      );
    }
  });

  it("finds nothing in a body naming no closing keyword", () => {
    assert.equal(closedTicketIn("Just some notes, no ticket here."), undefined);
  });
});

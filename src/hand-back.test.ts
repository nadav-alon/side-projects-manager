import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { discardBranch, handBack, type HandBackEnding } from "./hand-back.ts";
import {
  branch,
  checkout,
  commitSha,
  issueNumber,
  modelName,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  type Ticket,
} from "./ports/index.ts";
import { FakeIssueTracker, FakeRepoHost } from "./testing/index.ts";

const REPO = repoSlug("nadav-alon/pilot");
const CHECKOUT = checkout(`${FakeRepoHost.MANAGED_LOCATION}/${REPO}`);
const BRANCH = branch("issue-7-add-the-thing");
const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/171");

function ports() {
  const tracker = new FakeIssueTracker();
  const repoHost = new FakeRepoHost();
  return { tracker, repoHost };
}

function implementationTicket() {
  return { number: issueNumber(7), title: "Add the thing" };
}

function reviewTicket() {
  return {
    number: issueNumber(8),
    title: "Review #7",
    pullRequest: { kind: "review" as const, url: PULL_REQUEST },
  };
}

function applyReviewTicket() {
  return {
    number: issueNumber(9),
    title: "Apply review on #7",
    pullRequest: { kind: "apply-review" as const, url: PULL_REQUEST },
  };
}

function rebaseTicket() {
  return {
    number: issueNumber(10),
    title: "Rebase #7",
    pullRequest: { kind: "rebase" as const, url: PULL_REQUEST },
  };
}

/** Registers `ticket` as eligible on `tracker`, and returns it. */
function eligible<T extends { number: ReturnType<typeof issueNumber>; title: string }>(
  tracker: FakeIssueTracker,
  ticket: T,
): T & Ticket {
  return tracker.addEligibleTicket(REPO, ticket) as T & Ticket;
}

describe("handBack", () => {
  describe("an implementation ticket whose agent gave up", () => {
    const ending = (run: Parameters<typeof gaveUpRun>[0] = {}): HandBackEnding => ({
      kind: "gave-up",
      checkout: CHECKOUT,
      run: gaveUpRun(run),
    });

    function gaveUpRun(overrides: {
      commits?: ReturnType<typeof commitSha>[];
      output?: string;
      reason?: string;
    }) {
      return {
        kind: "gave-up" as const,
        branch: BRANCH,
        commits: overrides.commits ?? [commitSha("c0ffee1")],
        output: overrides.output ?? "I could not make the tests pass",
        tokensUsed: tokenCount(42_000),
        reason: overrides.reason ?? "the tests would not go green",
      };
    }

    it("discards the branch, relabels the ticket, and quotes why it stopped and what it said", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      const record = await handBack({ tracker, repoHost }, ticket, ending());

      assert.deepEqual(record, { outcome: "handed-back" });
      assert.deepEqual(repoHost.discarded, [{ directory: CHECKOUT, branch: BRANCH }]);
      const [handback] = tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback.comment, /the tests would not go green/);
      assert.match(handback.comment, /I could not make the tests pass/);
      assert.match(handback.comment, /branch it worked on has been discarded/);
      assert.match(handback.comment, /will not be retried/);
      assert.equal(tracker.carriesLabel(ticket, "ready-for-human"), true);
    });

    it("has nothing to discard when the agent committed nothing", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, ending({ commits: [] }));

      assert.deepEqual(repoHost.discarded, []);
      assert.doesNotMatch(tracker.handbacks[0]?.comment ?? "", /discard/);
    });

    it("hands the ticket back even when the branch will not delete, and says so", async (t) => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());
      t.mock.method(repoHost, "discardBranch", async () => {
        throw new Error("used by worktree at /elsewhere");
      });

      const record = await handBack({ tracker, repoHost }, ticket, ending());

      assert.deepEqual(record, { outcome: "handed-back" });
      assert.match(
        tracker.handbacks[0]?.comment ?? "",
        /could not be discarded.*used by worktree at \/elsewhere/s,
      );
    });

    it("reports a tracker that refuses the hand-back, rather than throwing", async (t) => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());
      t.mock.method(tracker, "handBack", async () => {
        throw new Error("gh is not logged in");
      });

      const record = await handBack({ tracker, repoHost }, ticket, ending());

      assert.deepEqual(record, { outcome: "refused", reason: "gh is not logged in" });
    });

    it("finds a ticket an overlapping run already closed, and touches nothing further", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());
      tracker.closeOutOfBand(ticket);

      const record = await handBack({ tracker, repoHost }, ticket, ending());

      assert.deepEqual(record, { outcome: "already-closed" });
      assert.deepEqual(tracker.handbacks, []);
    });

    it("keeps the comment small enough for a tracker to accept it", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack(
        { tracker, repoHost },
        ticket,
        ending({ output: "x".repeat(200_000), reason: "y".repeat(200_000) }),
      );

      // GitHub's own limit on a comment body. A comment it rejects is a
      // ticket that never gets handed back.
      assert.ok((tracker.handbacks[0]?.comment.length ?? 0) < 65_536);
    });

    it("quotes output that contains code fences without breaking out of the quote", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack(
        { tracker, repoHost },
        ticket,
        ending({ output: "I tried:\n```ts\nconst x = 1;\n```\nand it broke" }),
      );

      // A fence longer than any run of backticks inside, or the rest of the
      // output renders as Markdown and its `#123`s become cross-references.
      assert.match(tracker.handbacks[0]?.comment ?? "", /````\n/);
    });
  });

  it("hands a review ticket back with no branch to discard, on the agent's own reason", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, reviewTicket());

    const record = await handBack({ tracker, repoHost }, ticket, {
      kind: "review-gave-up",
      review: { kind: "gave-up", output: "I could not read the diff", tokensUsed: tokenCount(1), reason: "the review skill exited 1" },
      reason: "the review skill exited 1",
    });

    assert.deepEqual(record, { outcome: "handed-back" });
    assert.deepEqual(repoHost.discarded, []);
    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, /the review skill exited 1/);
    assert.match(comment, /I could not read the diff/);
  });

  it("hands an apply-review ticket back, naming the moved head and that its pull request is still a draft", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, applyReviewTicket());
    const moved = commitSha("b".repeat(40));

    await handBack({ tracker, repoHost }, ticket, {
      kind: "apply-review-gave-up",
      run: { kind: "gave-up", output: "pushed", tokensUsed: tokenCount(1), reason: "the push was rejected", movedHead: moved },
      reason: "the push was rejected",
      pullRequest: PULL_REQUEST,
    });

    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, new RegExp(`moved to \`${moved}\``));
    assert.match(comment, /is still a draft/);
  });

  it("hands a rebase ticket back, leaving its draft state alone rather than calling it a draft", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, rebaseTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "rebase-gave-up",
      run: { kind: "gave-up", output: "still conflicts", tokensUsed: tokenCount(1), reason: "still conflicts" },
      reason: "still conflicts",
      pullRequest: PULL_REQUEST,
    });

    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, /draft state was left as it was/);
    assert.doesNotMatch(comment, /is still a draft/);
  });

  describe("a model refusal", () => {
    it("names the model and discards the branch it left, when the ticket ran one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "model-refused",
        refusal: { model: modelName("opus"), words: "unknown model opus" },
        source: "model label",
        worked: {
          checkout: CHECKOUT,
          run: {
            kind: "model-refused",
            branch: BRANCH,
            commits: [commitSha("c0ffee1")],
            tokensUsed: tokenCount(0),
            refusal: { model: modelName("opus"), words: "unknown model opus" },
          },
        },
      });

      assert.deepEqual(repoHost.discarded, [{ directory: CHECKOUT, branch: BRANCH }]);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /opus/);
      assert.match(comment, /model label/);
    });

    it("names the model defaults, and discards nothing, for a review's own model refusal", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, reviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "model-refused",
        refusal: { model: modelName("haiku"), words: "unknown model haiku" },
        source: "model defaults",
      });

      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /haiku/);
      assert.match(comment, /model defaults for review tickets/);
    });
  });

  describe("unusable model labels", () => {
    it("names conflicting model labels", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "conflicting-model-labels",
        labels: ["model:opus", "model:haiku"],
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /model:opus/);
      assert.match(comment, /model:haiku/);
      assert.match(comment, /keep one/i);
    });

    it("names a model label naming no usable model", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "unusable-model-label",
        labels: ["model:"],
      });

      assert.match(tracker.handbacks[0]?.comment ?? "", /model:`/);
    });
  });

  it("hands a rebase ticket back whose mergeability never settled, leaving its draft state alone", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, rebaseTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "unsettled-mergeability",
      reason: "never finished computing mergeability",
      pullRequest: PULL_REQUEST,
    });

    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, /did not run this ticket/);
    assert.match(comment, /never finished computing mergeability/);
    assert.match(comment, /draft state was left as it was/);
  });

  it("names where a failed handover's work is", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, implementationTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "handover-failed",
      reason: "pull requests are disabled",
      branch: BRANCH,
      where: { kind: "unpushed", checkout: CHECKOUT },
    });

    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, new RegExp(BRANCH));
    assert.match(comment, /pull requests are disabled/);
  });

  describe("a finished run", () => {
    it("says it committed nothing, quoting what the agent said", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "finished",
        run: { kind: "finished", branch: BRANCH, commits: [], output: "there was nothing to add", tokensUsed: tokenCount(0) },
      });

      assert.match(tracker.handbacks[0]?.comment ?? "", /committed nothing/);
      assert.match(tracker.handbacks[0]?.comment ?? "", /there was nothing to add/);
    });

    it("names the draft pull request and the review queued against it", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());
      const reviewTicketRef: Ticket = { repo: REPO, number: issueNumber(11), title: "Review #7" };

      await handBack({ tracker, repoHost }, ticket, {
        kind: "finished",
        run: { kind: "finished", branch: BRANCH, commits: [commitSha("c0ffee1")], output: "done", tokensUsed: tokenCount(1000) },
        handover: { pullRequest: PULL_REQUEST, reviewTicket: reviewTicketRef },
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.ok(comment.includes(PULL_REQUEST));
      assert.match(comment, /#11/);
    });
  });
});

describe("discardBranch", () => {
  it("discards a branch the run committed to", async () => {
    const { repoHost } = ports();

    const discard = await discardBranch(repoHost, CHECKOUT, {
      kind: "gave-up",
      branch: BRANCH,
      commits: [commitSha("c0ffee1")],
      output: "",
      tokensUsed: tokenCount(0),
      reason: "",
    });

    assert.deepEqual(discard, { kind: "discarded" });
    assert.deepEqual(repoHost.discarded, [{ directory: CHECKOUT, branch: BRANCH }]);
  });

  it("has nothing to discard when the run left no commits", async () => {
    const { repoHost } = ports();

    const discard = await discardBranch(repoHost, CHECKOUT, {
      kind: "gave-up",
      branch: BRANCH,
      commits: [],
      output: "",
      tokensUsed: tokenCount(0),
      reason: "",
    });

    assert.deepEqual(discard, { kind: "none" });
    assert.deepEqual(repoHost.discarded, []);
  });

  it("keeps a branch git refuses to delete, and says why", async (t) => {
    const { repoHost } = ports();
    t.mock.method(repoHost, "discardBranch", async () => {
      throw new Error("used by worktree at /elsewhere");
    });

    const discard = await discardBranch(repoHost, CHECKOUT, {
      kind: "gave-up",
      branch: BRANCH,
      commits: [commitSha("c0ffee1")],
      output: "",
      tokensUsed: tokenCount(0),
      reason: "",
    });

    assert.deepEqual(discard, { kind: "kept", reason: "used by worktree at /elsewhere" });
  });
});

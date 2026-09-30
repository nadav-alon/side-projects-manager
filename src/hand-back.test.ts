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
  transcriptPath,
  type Ticket,
} from "./ports/index.ts";
import { endsWithTranscript, FakeIssueTracker, FakeRepoHost } from "./testing/index.ts";

const REPO = repoSlug("nadav-alon/pilot");
const CHECKOUT = checkout(`${FakeRepoHost.MANAGED_LOCATION}/${REPO}`);
const BRANCH = branch("issue-7-add-the-thing");
const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/171");
const TRANSCRIPT = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");

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

function specReviewTicket() {
  return {
    number: issueNumber(11),
    title: "Review the loop spec",
    specReview: true as const,
  };
}

function uxReviewTicket() {
  return {
    number: issueNumber(12),
    title: "Review how the app feels",
    uxReview: true as const,
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
    const ending = (
      run: Parameters<typeof gaveUpRun>[0] = {},
      transcript?: ReturnType<typeof transcriptPath>,
    ): HandBackEnding => {
      const built = gaveUpRun(run);
      return {
        kind: "gave-up",
        ticketKind: "implementation",
        reason: built.reason,
        output: built.output,
        checkout: CHECKOUT,
        run: { ...built, ...(transcript !== undefined && { transcript }) },
      };
    };

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

    it("names the transcript's host path as a code span, when the run left one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, ending({}, TRANSCRIPT));

      assert.match(
        tracker.handbacks[0]?.comment ?? "",
        endsWithTranscript(TRANSCRIPT),
      );
    });

    it("says nothing about a transcript when the run left none", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, ending());

      assert.doesNotMatch(tracker.handbacks[0]?.comment ?? "", /Transcript:/);
    });
  });

  it("hands a review ticket back with no branch to discard, on the agent's own reason", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, reviewTicket());

    const record = await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "review",
      reason: "the review skill exited 1",
      output: "I could not read the diff",
    });

    assert.deepEqual(record, { outcome: "handed-back" });
    assert.deepEqual(repoHost.discarded, []);
    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, /the review skill exited 1/);
    assert.match(comment, /I could not read the diff/);
    assert.doesNotMatch(comment, /Transcript:/);
  });

  it("names the transcript's host path on a review hand-back that left one", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, reviewTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "review",
      reason: "the review skill exited 1",
      output: "I could not read the diff",
      transcript: TRANSCRIPT,
    });

    assert.match(
      tracker.handbacks[0]?.comment ?? "",
      endsWithTranscript(TRANSCRIPT),
    );
  });

  it("hands an apply-review ticket back, naming the moved head and that its pull request is still a draft", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, applyReviewTicket());
    const moved = commitSha("b".repeat(40));

    await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "apply-review",
      reason: "the push was rejected",
      output: "pushed",
      pullRequest: PULL_REQUEST,
      movedHead: moved,
    });

    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, new RegExp(`moved to \`${moved}\``));
    assert.match(comment, /is still a draft/);
  });

  it("names the transcript's host path on an apply-review hand-back that left one", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, applyReviewTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "apply-review",
      reason: "the push was rejected",
      output: "pushed",
      pullRequest: PULL_REQUEST,
      transcript: TRANSCRIPT,
    });

    assert.match(
      tracker.handbacks[0]?.comment ?? "",
      endsWithTranscript(TRANSCRIPT),
    );
  });

  it("hands a rebase ticket back, leaving its draft state alone rather than calling it a draft", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, rebaseTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "rebase",
      reason: "still conflicts",
      output: "still conflicts",
      pullRequest: PULL_REQUEST,
    });

    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, /draft state was left as it was/);
    assert.doesNotMatch(comment, /is still a draft/);
  });

  it("names the transcript's host path on a rebase hand-back that left one", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, rebaseTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "rebase",
      reason: "still conflicts",
      output: "still conflicts",
      pullRequest: PULL_REQUEST,
      transcript: TRANSCRIPT,
    });

    assert.match(
      tracker.handbacks[0]?.comment ?? "",
      endsWithTranscript(TRANSCRIPT),
    );
  });

  it("hands a spec review ticket back with no branch to discard, on the agent's own reason", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, specReviewTicket());

    const record = await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "spec-review",
      reason: "could not find the supertask",
      output: "no parent issue",
    });

    assert.deepEqual(record, { outcome: "handed-back" });
    assert.deepEqual(repoHost.discarded, []);
    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, /could not find the supertask/);
    assert.match(comment, /no parent issue/);
    assert.doesNotMatch(comment, /Transcript:/);
  });

  it("names the transcript's host path on a spec review hand-back that left one", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, specReviewTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "spec-review",
      reason: "could not find the supertask",
      output: "no parent issue",
      transcript: TRANSCRIPT,
    });

    assert.match(
      tracker.handbacks[0]?.comment ?? "",
      endsWithTranscript(TRANSCRIPT),
    );
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

    it("names the transcript's host path on a model-refused hand-back that left one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, reviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "model-refused",
        refusal: { model: modelName("haiku"), words: "unknown model haiku" },
        source: "model defaults",
        transcript: TRANSCRIPT,
      });

      assert.match(tracker.handbacks[0]?.comment ?? "", endsWithTranscript(TRANSCRIPT));
    });
  });

  describe("a blocking discovery", () => {
    it("discards an implementation ticket's branch and quotes the correction, not a gave-up comment", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "discovery-blocked",
        discoveries: [
          {
            kind: "correction",
            title: "The ticket names the wrong file",
            body: "It should touch src/widget.ts, not src/gadget.ts.",
          },
        ],
        worked: {
          checkout: CHECKOUT,
          run: {
            kind: "finished",
            branch: BRANCH,
            commits: [commitSha("c0ffee1")],
            tokensUsed: tokenCount(42_000),
            output: "Found a correction while working this.",
          },
        },
      });

      assert.deepEqual(repoHost.discarded, [{ directory: CHECKOUT, branch: BRANCH }]);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /blocking discovery/);
      assert.doesNotMatch(comment, /the agent gave up/);
      assert.match(comment, /The ticket names the wrong file/);
      assert.match(comment, /src\/widget\.ts/);
      assert.match(comment, /branch it worked on has been discarded/);
      assert.equal(tracker.carriesLabel(ticket, "ready-for-human"), true);
    });

    it("names the implementation ticket for a pull request ticket, and discards nothing", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, reviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "discovery-blocked",
        discoveries: [
          {
            kind: "prerequisite",
            title: "Needs the widget port first",
            body: "There is no widget port to review against yet.",
          },
        ],
        crossTarget: { ...implementationTicket(), repo: REPO },
      });

      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.equal(tracker.handbacks[0]?.ticket.number, ticket.number);
      assert.match(comment, /Needs the widget port first/);
      assert.match(comment, /implementation ticket, nadav-alon\/pilot#7/);
    });

    it("names the supertask for a spec review ticket, rather than calling it an implementation ticket", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, specReviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "discovery-blocked",
        discoveries: [
          {
            kind: "correction",
            title: "The spec no longer matches",
            body: "The retry-policy sub-issue changed what #66 describes.",
          },
        ],
        crossTarget: { ...implementationTicket(), repo: REPO },
      });

      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /supertask, nadav-alon\/pilot#7/);
      assert.doesNotMatch(comment, /implementation ticket, nadav-alon\/pilot#7/);
    });

    it("names the transcript's host path when the run left one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, reviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "discovery-blocked",
        discoveries: [
          { kind: "correction", title: "Wrong ticket", body: "This is stale." },
        ],
        crossTarget: { ...implementationTicket(), repo: REPO },
        transcript: TRANSCRIPT,
      });

      assert.match(tracker.handbacks[0]?.comment ?? "", endsWithTranscript(TRANSCRIPT));
    });
  });

  describe("a run whose diff touched a uniform file", () => {
    function finishedRun(overrides: { transcript?: ReturnType<typeof transcriptPath> } = {}) {
      return {
        kind: "finished" as const,
        branch: BRANCH,
        commits: [commitSha("c0ffee1")],
        output: "Updated the coding standards doc.",
        tokensUsed: tokenCount(42_000),
        ...(overrides.transcript !== undefined && { transcript: overrides.transcript }),
      };
    }

    it("leaves the branch unpushed, relabels the ticket, and names the file touched", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      const record = await handBack({ tracker, repoHost }, ticket, {
        kind: "uniform-files-touched",
        ticketKind: "implementation",
        files: ["docs/agents/coding-standards.md"],
        checkout: CHECKOUT,
        run: finishedRun(),
      });

      assert.deepEqual(record, { outcome: "handed-back" });
      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /docs\/agents\/coding-standards\.md/);
      assert.match(comment, /no pull request was opened/i);
      assert.match(comment, new RegExp(`not pushed.*${CHECKOUT}`));
      assert.match(comment, /will not be retried/);
      assert.equal(tracker.carriesLabel(ticket, "ready-for-human"), true);
    });

    it("names every file touched, when the diff touched more than one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "uniform-files-touched",
        ticketKind: "implementation",
        files: ["docs/agents/coding-standards.md", ".github/workflows/rebase.yml"],
        checkout: CHECKOUT,
        run: finishedRun(),
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /docs\/agents\/coding-standards\.md/);
      assert.match(comment, /\.github\/workflows\/rebase\.yml/);
    });

    it("names the transcript's host path, when the run left one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "uniform-files-touched",
        ticketKind: "implementation",
        files: ["docs/agents/coding-standards.md"],
        checkout: CHECKOUT,
        run: finishedRun({ transcript: TRANSCRIPT }),
      });

      assert.match(tracker.handbacks[0]?.comment ?? "", endsWithTranscript(TRANSCRIPT));
    });

    it("hands an apply-review ticket back, naming the files touched, that the push was reverted, and its pull request", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, applyReviewTicket());

      const record = await handBack({ tracker, repoHost }, ticket, {
        kind: "uniform-files-touched",
        ticketKind: "apply-review",
        files: ["docs/agents/coding-standards.md"],
        pullRequest: PULL_REQUEST,
      });

      assert.deepEqual(record, { outcome: "handed-back" });
      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /docs\/agents\/coding-standards\.md/);
      assert.match(comment, /reverted/);
      assert.match(comment, new RegExp(PULL_REQUEST));
      assert.match(comment, /will not be retried/);
      assert.equal(tracker.carriesLabel(ticket, "ready-for-human"), true);
    });

    it("names the transcript's host path on an apply-review uniform-files hand-back that left one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, applyReviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "uniform-files-touched",
        ticketKind: "apply-review",
        files: ["docs/agents/coding-standards.md"],
        pullRequest: PULL_REQUEST,
        transcript: TRANSCRIPT,
      });

      assert.match(tracker.handbacks[0]?.comment ?? "", endsWithTranscript(TRANSCRIPT));
    });

    it("hands a rebase ticket back, naming the files touched and that the push was reverted", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, rebaseTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "uniform-files-touched",
        ticketKind: "rebase",
        files: ["docs/agents/coding-standards.md"],
        pullRequest: PULL_REQUEST,
      });

      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /docs\/agents\/coding-standards\.md/);
      assert.match(comment, /reverted/);
      assert.match(comment, /will not be retried/);
    });

    it("names why, when the force-back itself failed, and that the push is still on the pull request", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, applyReviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "uniform-files-touched",
        ticketKind: "apply-review",
        files: ["docs/agents/coding-standards.md"],
        pullRequest: PULL_REQUEST,
        notReverted: { reason: "the lease no longer matched" },
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /docs\/agents\/coding-standards\.md/);
      assert.match(comment, /could not be reverted/);
      assert.match(comment, /the lease no longer matched/);
      assert.match(comment, /still on the pull request/);
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

    it("names the labels as the ticket carries them, rather than normalizing their case", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "conflicting-model-labels",
        labels: ["Model:Opus", "model:haiku"],
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /`Model:Opus`/);
      assert.doesNotMatch(comment, /`model:Opus`/);
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

  describe("an unusable size label", () => {
    it("quotes the size labels as written and names the sizes the budget document knows", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "unusable-size-label",
        labels: ["size:XXL"],
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /`size:XXL`/);
      assert.match(comment, /S, M, L, XL/);
      assert.match(comment, /`size:<size>`/);
    });

    it("names nothing was run or spent, since it is caught ahead of the gate", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, implementationTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "unusable-size-label",
        labels: ["size:XXL"],
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /did not run this ticket/);
      assert.match(comment, /Nothing was run and nothing was spent/);
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

  it("names the transcript's host path on a handover-failed hand-back that left one", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, implementationTicket());

    await handBack({ tracker, repoHost }, ticket, {
      kind: "handover-failed",
      reason: "pull requests are disabled",
      branch: BRANCH,
      where: { kind: "unpushed", checkout: CHECKOUT },
      transcript: TRANSCRIPT,
    });

    assert.match(tracker.handbacks[0]?.comment ?? "", endsWithTranscript(TRANSCRIPT));
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

  it("hands a ux review ticket back with no branch to discard, on the agent's own reason", async () => {
    const { tracker, repoHost } = ports();
    const ticket = eligible(tracker, uxReviewTicket());

    const record = await handBack({ tracker, repoHost }, ticket, {
      kind: "gave-up",
      ticketKind: "ux-review",
      reason: "the project has no ux script",
      output: "nothing to drive",
      transcript: TRANSCRIPT,
    });

    assert.deepEqual(record, { outcome: "handed-back" });
    assert.deepEqual(repoHost.discarded, []);
    const comment = tracker.handbacks[0]?.comment ?? "";
    assert.match(comment, /the project has no ux script/);
    assert.match(comment, /nothing to drive/);
    assert.match(comment, endsWithTranscript(TRANSCRIPT));
  });

  describe("a ux review run that finished", () => {
    it("carries its own report as the comment, naming the kind of ticket it ran", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, uxReviewTicket());

      const record = await handBack({ tracker, repoHost }, ticket, {
        kind: "ux-review-finished",
        output: "the save button is below the fold on a phone",
        transcript: TRANSCRIPT,
      });

      assert.deepEqual(record, { outcome: "handed-back" });
      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /ran this ux review ticket/);
      assert.match(comment, /the save button is below the fold on a phone/);
      assert.match(comment, /will not be retried/);
      assert.match(comment, endsWithTranscript(TRANSCRIPT));
    });
  });

  describe("a spec review run that finished", () => {
    it("carries its own report as the comment, since there is no pull request to have posted it to", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, specReviewTicket());

      const record = await handBack({ tracker, repoHost }, ticket, {
        kind: "spec-review-finished",
        output: "the retry-policy sub-issue never landed the change the spec described",
      });

      assert.deepEqual(record, { outcome: "handed-back" });
      assert.deepEqual(repoHost.discarded, []);
      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /the retry-policy sub-issue never landed the change the spec described/);
      assert.match(comment, /will not be retried/);
    });

    it("names the transcript's host path when it left one", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, specReviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "spec-review-finished",
        output: "no drift found",
        transcript: TRANSCRIPT,
      });

      assert.match(
        tracker.handbacks[0]?.comment ?? "",
        endsWithTranscript(TRANSCRIPT),
      );
    });

    it("says the report was cut and points at the transcript when the report overruns the quote", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, specReviewTicket());
      const report = `the earliest, highest-priority finding\n${"x".repeat(20_001)}`;

      await handBack({ tracker, repoHost }, ticket, {
        kind: "spec-review-finished",
        output: report,
        transcript: TRANSCRIPT,
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.doesNotMatch(comment, /the earliest, highest-priority finding/);
      assert.match(comment, /only the tail of the report/);
      assert.match(comment, /transcript below has the rest/);
    });

    it("says the report was cut and that no transcript holds the rest, when the run left none", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, specReviewTicket());
      const report = "x".repeat(20_001);

      await handBack({ tracker, repoHost }, ticket, {
        kind: "spec-review-finished",
        output: report,
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /only the tail of the report/);
      assert.match(comment, /left no transcript/);
    });

    it("says nothing about a cut when the report fits", async () => {
      const { tracker, repoHost } = ports();
      const ticket = eligible(tracker, specReviewTicket());

      await handBack({ tracker, repoHost }, ticket, {
        kind: "spec-review-finished",
        output: "no drift found",
        transcript: TRANSCRIPT,
      });

      const comment = tracker.handbacks[0]?.comment ?? "";
      assert.doesNotMatch(comment, /only the tail of the report/);
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

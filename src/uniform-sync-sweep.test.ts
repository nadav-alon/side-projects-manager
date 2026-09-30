import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  branch,
  pullRequestUrl,
  READY_FOR_HUMAN_PULL_REQUEST_LABEL,
  repoSlug,
  UNIFORM_FILES,
} from "./ports/index.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { FakeHarness } from "./testing/fake-harness.ts";
import { FakeRepoHost } from "./testing/fake-repo-host.ts";
import { uniformSyncSweep } from "./uniform-sync-sweep.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("uniformSyncSweep", () => {
  it("clones the project and asks the harness to bring its uniform files in step", async () => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();

    await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.deepEqual(repoHost.clones, [PILOT]);
    assert.deepEqual(harness.syncs, [
      `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
    ]);
  });

  it("answers unchanged, and proposes nothing, once the checkout already matched", async () => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    harness.changed = [];

    const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.deepEqual(outcome, { repo: PILOT, result: { kind: "unchanged" } });
    assert.deepEqual(repoHost.proposals, []);
  });

  it("proposes the stale files, naming them, once the checkout had drifted", async () => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    harness.changed = ["docs/agents/coding-standards.md"];

    const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.equal(repoHost.proposals.length, 1);
    const [proposal] = repoHost.proposals;
    assert.deepEqual(proposal?.paths, ["docs/agents/coding-standards.md"]);
    assert.equal(proposal?.branch, branch("uniform-sync"));
    assert.match(proposal?.body ?? "", /docs\/agents\/coding-standards\.md/);
    assert.deepEqual(outcome, {
      repo: PILOT,
      result: {
        kind: "proposed",
        branch: branch("uniform-sync"),
        url: FakeRepoHost.PROPOSED_PULL_REQUEST,
      },
    });
  });

  it("refuses, without ever calling sync, once the checkout has an uncommitted change to a uniform file", async () => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    repoHost.uncommittedChanges = () => true;

    const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.equal(outcome.result.kind, "refused");
    assert.deepEqual(harness.syncs, []);
    assert.deepEqual(repoHost.proposals, []);
  });

  it("checks the checkout's uniform files, not any dirty file, before syncing", async () => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    let asked: readonly string[] = [];
    repoHost.uncommittedChanges = (paths) => {
      asked = paths;
      return false;
    };

    await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.deepEqual(asked, [...UNIFORM_FILES]);
  });

  it("answers refused rather than throwing when the clone fails", async (t) => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    t.mock.method(repoHost, "clone", async () => {
      throw new Error("the repo host is down");
    });

    const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.equal(outcome.repo, PILOT);
    assert.equal(outcome.result.kind, "refused");
    assert.match(
      outcome.result.kind === "refused" ? outcome.result.error : "",
      /the repo host is down/,
    );
  });

  it("answers refused rather than throwing when proposing the fix fails", async (t) => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    harness.changed = ["docs/agents/coding-standards.md"];
    t.mock.method(repoHost, "commitAndPropose", async () => {
      throw new Error("push rejected");
    });

    const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.equal(outcome.result.kind, "refused");
    assert.match(
      outcome.result.kind === "refused" ? outcome.result.error : "",
      /push rejected/,
    );
  });

  describe("in a project standing turbo", () => {
    const CURRENT = "the manager's copy\n";
    const STALE = ["docs/agents/coding-standards.md"];

    function turbo() {
      const repoHost = new FakeRepoHost();
      const harness = new FakeHarness();
      harness.changed = STALE;
      repoHost.setPullRequestFiles(FakeRepoHost.PROPOSED_PULL_REQUEST, [
        { path: STALE[0] ?? "", content: CURRENT },
      ]);
      harness.comparisons.set(CURRENT, "current");
      return { repoHost, harness, merge: { clock: new FakeClock() } };
    }

    it("marks the proposed pull request ready and merges it once its checks are green", async () => {
      const { repoHost, harness, merge } = turbo();

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(outcome, {
        repo: PILOT,
        result: { kind: "merged", url: FakeRepoHost.PROPOSED_PULL_REQUEST },
      });
      assert.deepEqual(repoHost.readyMarked, [FakeRepoHost.PROPOSED_PULL_REQUEST]);
      assert.deepEqual(repoHost.merged, [FakeRepoHost.PROPOSED_PULL_REQUEST]);
    });

    it("merges only the head it read the files at, so a later push cannot ride along", async () => {
      const { repoHost, harness, merge } = turbo();

      await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(repoHost.mergedHeads, [FakeRepoHost.HEAD]);
    });

    it("merges nothing, and labels nothing, when the pull request holds an earlier version of the manager's file", async () => {
      const { repoHost, harness, merge } = turbo();
      repoHost.setPullRequestFiles(FakeRepoHost.PROPOSED_PULL_REQUEST, [
        { path: STALE[0] ?? "", content: "an older version\n" },
      ]);
      harness.comparisons.set("an older version\n", "earlier");

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(outcome.result, {
        kind: "outdated",
        url: FakeRepoHost.PROPOSED_PULL_REQUEST,
      });
      assert.deepEqual(repoHost.merged, []);
      assert.deepEqual(repoHost.labelled, []);
    });

    it("labels it ready-for-human, naming the file, when the pull request holds bytes the manager never had", async () => {
      const { repoHost, harness, merge } = turbo();
      repoHost.setPullRequestFiles(FakeRepoHost.PROPOSED_PULL_REQUEST, [
        { path: STALE[0] ?? "", content: CURRENT },
        { path: "docs/agents/domain.md", content: "somebody's edit\n" },
      ]);

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.equal(outcome.result.kind, "left-for-human");
      assert.match(
        outcome.result.kind === "left-for-human" ? outcome.result.reason : "",
        /docs\/agents\/domain\.md/,
      );
      assert.deepEqual(repoHost.merged, []);
    });

    it("labels it ready-for-human when the pull request deletes a file", async () => {
      const { repoHost, harness, merge } = turbo();
      repoHost.setPullRequestFiles(FakeRepoHost.PROPOSED_PULL_REQUEST, [{ path: STALE[0] ?? "" }]);

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.equal(outcome.result.kind, "left-for-human");
      assert.deepEqual(repoHost.merged, []);
    });

    it("leaves a sync pull request already labelled ready-for-human alone, pushing and merging nothing", async () => {
      const { repoHost, harness, merge } = turbo();
      const waiting = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/3");
      repoHost.setOpenPullRequestOn(PILOT, branch("uniform-sync"), {
        url: waiting,
        labels: [READY_FOR_HUMAN_PULL_REQUEST_LABEL],
      });

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(outcome.result, {
        kind: "left-for-human",
        url: waiting,
        reason: "waiting on the developer",
      });
      assert.deepEqual(harness.syncs, []);
      assert.deepEqual(repoHost.proposals, []);
      assert.deepEqual(repoHost.merged, []);
      assert.deepEqual(repoHost.labelled, []);
    });

    it("labels it ready-for-human when the pull request also touches a file outside the uniform files, whatever its bytes", async () => {
      const { repoHost, harness, merge } = turbo();
      repoHost.setPullRequestFiles(FakeRepoHost.PROPOSED_PULL_REQUEST, [
        { path: STALE[0] ?? "", content: CURRENT },
        { path: "README.md", content: CURRENT },
      ]);

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.equal(outcome.result.kind, "left-for-human");
      assert.match(
        outcome.result.kind === "left-for-human" ? outcome.result.reason : "",
        /README\.md/,
      );
      assert.deepEqual(repoHost.merged, []);
    });

    it("waits out pending checks before it merges", async () => {
      const { repoHost, harness, merge } = turbo();
      let reads = 0;
      repoHost.checksStatus = () => (++reads < 3 ? "pending" : "green");

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.equal(outcome.result.kind, "merged");
      assert.equal(reads, 3);
    });

    it("labels the pull request ready-for-human, and merges nothing, once its checks fail", async () => {
      const { repoHost, harness, merge } = turbo();
      repoHost.checksStatus = () => "red";

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(outcome.result, {
        kind: "left-for-human",
        url: FakeRepoHost.PROPOSED_PULL_REQUEST,
        reason: "checks failing",
      });
      assert.deepEqual(repoHost.labelled, [
        {
          pullRequest: FakeRepoHost.PROPOSED_PULL_REQUEST,
          label: READY_FOR_HUMAN_PULL_REQUEST_LABEL,
        },
      ]);
      assert.deepEqual(repoHost.merged, []);
    });

    it("labels it ready-for-human when checks are still pending after the wait", async () => {
      const { repoHost, harness, merge } = turbo();
      repoHost.checksStatus = () => "pending";

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(outcome.result, {
        kind: "left-for-human",
        url: FakeRepoHost.PROPOSED_PULL_REQUEST,
        reason: "checks still running",
      });
      assert.deepEqual(repoHost.merged, []);
    });

    it("labels it ready-for-human, naming the refusal, when the host will not merge it", async (t) => {
      const { repoHost, harness, merge } = turbo();
      t.mock.method(repoHost, "mergePullRequest", async () => {
        throw new Error("Pull request is not mergeable");
      });

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(outcome.result, {
        kind: "left-for-human",
        url: FakeRepoHost.PROPOSED_PULL_REQUEST,
        reason: "Pull request is not mergeable",
      });
      assert.equal(repoHost.labelled.length, 1);
    });

    it("merges the pull request already open on the sync branch when the push found one", async (t) => {
      const { repoHost, harness, merge } = turbo();
      const open = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/3");
      t.mock.method(repoHost, "commitAndPropose", async () => ({
        kind: "pushed",
        branch: branch("uniform-sync"),
        failure: "a pull request for uniform-sync already exists",
      }));
      repoHost.setOpenPullRequestOn(PILOT, branch("uniform-sync"), { url: open, labels: [] });
      repoHost.setPullRequestFiles(open, [{ path: STALE[0] ?? "", content: CURRENT }]);

      const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT, merge);

      assert.deepEqual(outcome.result, { kind: "merged", url: open });
    });
  });

  it("leaves a sync pull request labelled ready-for-human alone in a project that is not turbo, too", async () => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    harness.changed = ["docs/agents/coding-standards.md"];
    const waiting = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/3");
    repoHost.setOpenPullRequestOn(PILOT, branch("uniform-sync"), {
      url: waiting,
      labels: [READY_FOR_HUMAN_PULL_REQUEST_LABEL],
    });

    const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.deepEqual(outcome.result, {
      kind: "left-for-human",
      url: waiting,
      reason: "waiting on the developer",
    });
    assert.deepEqual(harness.syncs, []);
    assert.deepEqual(repoHost.proposals, []);
  });

  it("leaves the proposed pull request open in a project that is not turbo", async () => {
    const repoHost = new FakeRepoHost();
    const harness = new FakeHarness();
    harness.changed = ["docs/agents/coding-standards.md"];

    const outcome = await uniformSyncSweep({ repoHost, harness }, PILOT);

    assert.equal(outcome.result.kind, "proposed");
    assert.deepEqual(repoHost.merged, []);
  });
});

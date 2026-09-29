import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branch, repoSlug } from "./ports/index.ts";
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
});

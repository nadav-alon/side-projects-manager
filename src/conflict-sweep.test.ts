import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { conflictSweep } from "./conflict-sweep.ts";
import {
  issueNumber,
  NEEDS_REBASE_LABEL,
  pullRequestLabel,
  pullRequestUrl,
  repoSlug,
} from "./ports/index.ts";
import { FakeRepoHost } from "./testing/fake-repo-host.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const NEEDS_REBASE = pullRequestLabel(NEEDS_REBASE_LABEL);
const NO_OPEN_ISSUES = { issues: [], truncated: false };

const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");
const OTHER_PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/8");

describe("conflictSweep", () => {
  it("never reads or labels a pull request whose body names no closed ticket", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [{ url: PULL_REQUEST, labels: [] }]);
    host.mergeStatus = () => "conflicting";
    const readMergeStatus = t.mock.method(host, "readMergeStatus");

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.equal(readMergeStatus.mock.callCount(), 0);
    assert.deepEqual(host.labelled, []);
    assert.deepEqual(outcome, { repo: PILOT, changes: [], refusals: [] });
  });

  it("labels a conflicting pull request that does not carry needs-rebase", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "conflicting";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(host.labelled, [{ pullRequest: PULL_REQUEST, label: NEEDS_REBASE }]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: PULL_REQUEST, action: "labelled" },
    ]);
    assert.deepEqual(outcome.refusals, []);
  });

  it("does not label a conflicting pull request that already carries needs-rebase", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "conflicting";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(host.labelled, []);
    assert.deepEqual(outcome.changes, []);
  });

  it("leaves an unknown pull request untouched", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "unknown";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(host.labelled, []);
    assert.deepEqual(outcome, { repo: PILOT, changes: [], refusals: [] });
  });

  it("records a refused mergeability read and carries on to the next pull request", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      { url: OTHER_PULL_REQUEST, labels: [], closes: issueNumber(2) },
    ]);
    host.mergeStatus = () => "conflicting";
    t.mock.method(host, "readMergeStatus", async (pullRequest: typeof PULL_REQUEST) => {
      if (pullRequest === PULL_REQUEST) {
        throw new Error("mergeability check refused");
      }
      return "conflicting";
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome.refusals, [
      { action: "read", pullRequest: PULL_REQUEST, error: "mergeability check refused" },
    ]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: OTHER_PULL_REQUEST, action: "labelled" },
    ]);
  });

  it("records a refused label and carries on to the next pull request", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      { url: OTHER_PULL_REQUEST, labels: [], closes: issueNumber(2) },
    ]);
    host.mergeStatus = () => "conflicting";
    t.mock.method(host, "labelPullRequest", async (pullRequest: typeof PULL_REQUEST) => {
      if (pullRequest === PULL_REQUEST) {
        throw new Error("label does not exist");
      }
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome.refusals, [
      { action: "label", pullRequest: PULL_REQUEST, error: "label does not exist" },
    ]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: OTHER_PULL_REQUEST, action: "labelled" },
    ]);
  });

  it("removes needs-rebase from a clean pull request that carries it", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "clean";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.equal(host.hasNeedsRebaseLabel(PULL_REQUEST), false);
    assert.deepEqual(outcome.changes, [
      { pullRequest: PULL_REQUEST, action: "unlabelled" },
    ]);
    assert.deepEqual(outcome.refusals, []);
  });

  it("does nothing to a clean pull request that does not carry needs-rebase", async () => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
    ]);
    host.mergeStatus = () => "clean";

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome, { repo: PILOT, changes: [], refusals: [] });
  });

  it("records a refused unlabel and carries on to the next pull request", async (t) => {
    const host = new FakeRepoHost();
    host.setOpenPullRequests(PILOT, [
      { url: PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(1) },
      { url: OTHER_PULL_REQUEST, labels: [NEEDS_REBASE], closes: issueNumber(2) },
    ]);
    host.mergeStatus = () => "clean";
    t.mock.method(host, "removeNeedsRebaseLabel", async (pullRequest: typeof PULL_REQUEST) => {
      if (pullRequest === PULL_REQUEST) {
        throw new Error("label already gone");
      }
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome.refusals, [
      { action: "unlabel", pullRequest: PULL_REQUEST, error: "label already gone" },
    ]);
    assert.deepEqual(outcome.changes, [
      { pullRequest: OTHER_PULL_REQUEST, action: "unlabelled" },
    ]);
  });

  it("ends the project's sweep on a refused listing, without a per-pull-request refusal", async (t) => {
    const host = new FakeRepoHost();
    t.mock.method(host, "listOpenPullRequests", async () => {
      throw new Error("listing refused");
    });

    const outcome = await conflictSweep(host, PILOT, false, NO_OPEN_ISSUES);

    assert.deepEqual(outcome, {
      repo: PILOT,
      changes: [],
      refusals: [{ action: "list", error: "listing refused" }],
    });
  });
});

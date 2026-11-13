import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { failingCheckThreadBody, postFailingCheckThreads } from "./failing-check-threads.ts";
import { checkRunUrl, pullRequestUrl } from "./ports/index.ts";
import { FakeClock, FakeRepoHost } from "./testing/index.ts";

const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");

describe("postFailingCheckThreads", () => {
  it("posts each failing check as a thread naming it, quoting its error lines and linking its run", async () => {
    const host = new FakeRepoHost();
    host.checksStatus = () => "red";
    host.failingChecks = () => [
      { name: "test", errorLines: ["Error: boom", "FAIL src/a.test.ts"], runUrl: checkRunUrl("https://github.com/nadav-alon/pilot/actions/runs/1") },
      { name: "lint", errorLines: [], runUrl: checkRunUrl("https://github.com/nadav-alon/pilot/actions/runs/2") },
    ];

    const posted = await postFailingCheckThreads(host, new FakeClock(), PULL_REQUEST);

    assert.equal(posted, 2);
    assert.equal(host.reviewThreads.length, 2);
    const [first, second] = host.reviewThreads;
    assert.equal(first?.pullRequest, PULL_REQUEST);
    assert.match(first?.body ?? "", /Failing check: test/);
    assert.match(first?.body ?? "", /Error: boom\nFAIL src\/a\.test\.ts/);
    assert.match(first?.body ?? "", /actions\/runs\/1/);
    assert.match(second?.body ?? "", /Failing check: lint/);
    assert.match(second?.body ?? "", /actions\/runs\/2/);
  });

  it("posts none when the checks are green or there are none", async () => {
    const host = new FakeRepoHost();
    host.failingChecks = () => [{ name: "stale", errorLines: [], runUrl: checkRunUrl("https://example.test/run") }];

    assert.equal(await postFailingCheckThreads(host, new FakeClock(), PULL_REQUEST), 0);
    assert.deepEqual(host.reviewThreads, []);
  });

  it("does not post a check again while its thread is still open", async () => {
    const host = new FakeRepoHost();
    host.checksStatus = () => "red";
    host.failingChecks = () => [{ name: "test", errorLines: ["Error: boom"], runUrl: checkRunUrl("https://example.test/run") }];

    assert.equal(await postFailingCheckThreads(host, new FakeClock(), PULL_REQUEST), 1);
    assert.equal(await postFailingCheckThreads(host, new FakeClock(), PULL_REQUEST), 0);
    assert.equal(host.reviewThreads.length, 1);
  });

  it("waits for pending checks to settle before reading the failing ones", async () => {
    const host = new FakeRepoHost();
    const reads = ["pending", "red"] as const;
    let read = 0;
    host.checksStatus = () => reads[Math.min(read++, 1)] ?? "red";
    host.failingChecks = () => [{ name: "test", errorLines: [], runUrl: checkRunUrl("https://example.test/run") }];

    assert.equal(await postFailingCheckThreads(host, new FakeClock(), PULL_REQUEST), 1);
  });
});

describe("failingCheckThreadBody", () => {
  it("leaves the run line out when the check reported no run", () => {
    assert.equal(failingCheckThreadBody({ name: "ci/legacy", errorLines: [] }), "Failing check: ci/legacy");
  });
});

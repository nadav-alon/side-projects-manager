import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHECKS_STILL_PENDING_NOTE, failingCheckThreadBody, postFailingCheckThreads } from "./failing-check-threads.ts";
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

  it("keeps waiting while a check is pending even though another already failed, then posts both", async () => {
    const host = new FakeRepoHost();
    let reads = 0;
    host.checksPending = () => ++reads < 3;
    host.checksStatus = () => "red";
    host.failingChecks = () =>
      reads < 3
        ? [{ name: "lint", errorLines: [] }]
        : [
            { name: "lint", errorLines: [] },
            { name: "test", errorLines: [] },
          ];

    assert.equal(await postFailingCheckThreads(host, new FakeClock(), PULL_REQUEST), 2);
    assert.deepEqual(host.comments, []);
  });

  it("notes on the pull request that checks went unread when the wait times out still pending", async () => {
    const host = new FakeRepoHost();
    host.checksPending = () => true;
    host.checksStatus = () => "pending";

    assert.equal(await postFailingCheckThreads(host, new FakeClock(), PULL_REQUEST), 0);
    assert.deepEqual(host.comments, [{ pullRequest: PULL_REQUEST, body: CHECKS_STILL_PENDING_NOTE }]);
  });
});

describe("failingCheckThreadBody", () => {
  it("leaves the run line out when the check reported no run", () => {
    assert.equal(failingCheckThreadBody({ name: "ci/legacy", errorLines: [] }), "Failing check: ci/legacy");
  });
});

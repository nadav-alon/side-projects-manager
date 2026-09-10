import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { morningRun, type ProjectOutcome } from "./morning-run.ts";
import { branch, repoSlug, tokenCount } from "./ports/index.ts";
import {
  FROZEN_NOW,
  FakeRepoHost,
  type FakePorts,
  fakePorts,
} from "./testing/index.ts";

const MANAGER = repoSlug("nadav-alon/side-projects-manager");
const PILOT = repoSlug("nadav-alon/pilot");

const YESTERDAY = new Date("2025-12-31T06:00:00.000Z");

/** What the report says happened, without the timestamps a test didn't set. */
function verdicts(projects: ProjectOutcome[]): [string, string][] {
  return projects.map((project) => [project.repo, project.verdict]);
}

describe("morningRun", () => {
  it("reports a dry queue when nothing is registered", async () => {
    const ports = fakePorts();

    const report = await morningRun(ports);

    assert.equal(report.outcome, "dry-queue");
    assert.deepEqual(report.projects, []);
    assert.match(report.message, /nothing to do/i);
  });

  it("reports a dry queue when every backlog is empty", async () => {
    const ports = fakePorts();
    ports.store.register(MANAGER);
    ports.store.register(PILOT);

    const report = await morningRun(ports);

    assert.equal(report.outcome, "dry-queue");
    assert.deepEqual(verdicts(report.projects), [
      [MANAGER, "no-eligible-tickets"],
      [PILOT, "no-eligible-tickets"],
    ]);
    assert.match(report.message, /nothing to do/i);
  });

  it("asks the tracker about every registered project", async (t) => {
    const ports = fakePorts();
    ports.store.register(MANAGER);
    ports.store.register(PILOT);
    const listEligibleTickets = t.mock.method(
      ports.tracker,
      "listEligibleTickets",
    );

    await morningRun(ports);

    assert.equal(listEligibleTickets.mock.callCount(), 2);
    assert.deepEqual(
      listEligibleTickets.mock.calls.map((call) => call.arguments[0]),
      [MANAGER, PILOT],
    );
  });

  it("never runs an agent when the queue is dry", async (t) => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    const run = t.mock.method(ports.sandbox, "run");

    await morningRun(ports);

    assert.equal(run.mock.callCount(), 0);
  });

  it("selects the project it found work in", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: 7,
      title: "Add the thing",
    });

    const report = await morningRun(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(verdicts(report.projects), [[PILOT, "selected"]]);
    assert.match(report.message, /nadav-alon\/pilot/);
  });

  it("stops considering projects once one is selected, since an iteration works one project", async (t) => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.store.register(MANAGER);
    ports.tracker.addEligibleTicket(PILOT, {
      number: 7,
      title: "Add the thing",
    });
    const listEligibleTickets = t.mock.method(
      ports.tracker,
      "listEligibleTickets",
    );

    await morningRun(ports);

    assert.equal(listEligibleTickets.mock.callCount(), 1);
    assert.deepEqual(listEligibleTickets.mock.calls[0]?.arguments, [PILOT]);
  });

  it("timestamps the report from the injected clock, not wall time", async () => {
    const ports = fakePorts();
    const startedAt = ports.clock.now();

    const report = await morningRun(ports);

    assert.deepEqual(report.startedAt, startedAt);
  });

  describe("a paused project", () => {
    it("is never considered, however much work it has", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT, { paused: true });
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      const listEligibleTickets = t.mock.method(
        ports.tracker,
        "listEligibleTickets",
      );

      const report = await morningRun(ports);

      assert.equal(listEligibleTickets.mock.callCount(), 0);
      assert.equal(report.outcome, "dry-queue");
    });

    it("does not stop the projects behind it being worked", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER, { paused: true });
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      const report = await morningRun(ports);

      assert.equal(report.outcome, "work-selected");
      assert.deepEqual(verdicts(report.projects), [
        [MANAGER, "paused"],
        [PILOT, "selected"],
      ]);
    });

    it("is reported as skipped for being paused", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER, { paused: true });
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.match(
        report.message,
        /nadav-alon\/side-projects-manager \(paused\)/,
      );
      assert.match(
        report.message,
        /nadav-alon\/pilot \(no ready-for-agent tickets\)/,
      );
    });
  });

  describe("state", () => {
    it("reports a project with no state as never worked", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.equal(report.projects[0]?.lastWorkedAt, undefined);
    });

    it("reports when a project was last worked", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });

      const report = await morningRun(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, YESTERDAY);
    });

    it("is written back after every invocation, including a quiet one", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const saveState = t.mock.method(ports.store, "saveState");

      await morningRun(ports);

      assert.equal(saveState.mock.callCount(), 1);
    });

    it("keeps what earlier invocations recorded", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });

      await morningRun(ports);
      const report = await morningRun(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, YESTERDAY);
    });
  });

  describe("the run", () => {
    it("passes the selected ticket and the project checkout to the sandbox", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningRun(ports);

      assert.deepEqual(ports.sandbox.runs, [
        { ticket, checkout: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}` },
      ]);
    });

    it("asks the repo host for a checkout of the project it selected", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER, { paused: true });
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningRun(ports);

      assert.deepEqual(ports.repoHost.clones, [PILOT]);
    });

    it("clones nothing when the queue is dry", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      await morningRun(ports);

      assert.deepEqual(ports.repoHost.clones, []);
      assert.deepEqual(ports.sandbox.runs, []);
    });

    it("reports the branch, commits, output and cost the run came back with", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1", "c0ffee2"],
        output: "implemented the thing",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      assert.deepEqual(report.run, {
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1", "c0ffee2"],
        output: "implemented the thing",
        tokensUsed: tokenCount(42_000),
      });
    });

    it("has no run to report on a quiet morning", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.equal(report.run, undefined);
    });

    it("says in the message what the run left behind", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1"],
        output: "",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      assert.match(report.message, /nadav-alon\/pilot/);
      assert.match(report.message, /issue-7-add-the-thing/);
    });
  });

  describe("what a run records", () => {
    it("records the project as worked, at the clock's instant", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningRun(ports);
      const report = await morningRun(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, FROZEN_NOW);
    });

    it("records what the run cost", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "",
        tokensUsed: tokenCount(42_000),
      });

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
    });

    it("keeps the runs earlier invocations recorded", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(
        state.get(PILOT)?.runs.map((run) => run.at),
        [YESTERDAY, FROZEN_NOW],
      );
    });

    it("records nothing against a project it never ran", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.equal(state.get(PILOT), undefined);
    });
  });

  describe("the draft pull request", () => {
    /** A run that did the work: commits on a branch, against ticket #7. */
    function ranSuccessfully(ports: FakePorts): void {
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1"],
        output: "",
        tokensUsed: tokenCount(42_000),
      });
    }

    it("is opened for the branch a run left commits on", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1"],
        output: "",
        tokensUsed: tokenCount(0),
      });

      await morningRun(ports);

      assert.deepEqual(ports.repoHost.pullRequests, [
        {
          directory: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          branch: branch("issue-7-add-the-thing"),
          ticket,
        },
      ]);
    });

    it("is reported, so the developer is told where to review", async () => {
      const ports = fakePorts();
      ranSuccessfully(ports);

      const report = await morningRun(ports);

      assert.equal(report.pullRequest, FakeRepoHost.DRAFT_PULL_REQUEST);
      assert.match(report.message, /https:\/\/github\.com\/pulls\/2/);
    });

    it("is not opened for a run that committed nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "the agent gave up",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(report.pullRequest, undefined);
    });

    it("leaves the message saying nothing was left behind", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "the agent gave up",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      // Never the branch: the sandbox keeps no branch for a run that
      // committed nothing, so naming one would send the developer looking
      // for something that was never created.
      assert.match(report.message, /left nothing behind/);
      assert.doesNotMatch(report.message, /issue-7-add-the-thing/);
    });

    it("is not opened for a run the agent did not finish", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1"],
        output: "the tests are still red",
        failure: "the agent gave up",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(report.pullRequest, undefined);
    });

    it("leaves a failed run's commits named, so they can be judged", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1"],
        output: "the tests are still red",
        failure: "the agent gave up",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      assert.match(report.message, /1 commit on issue-7-add-the-thing/);
      assert.match(report.message, /the agent gave up/);
    });

    it("is not opened on a morning that ran nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(report.pullRequest, undefined);
    });

    it("still leaves the project recorded as worked, at what the run cost", async () => {
      const ports = fakePorts();
      ranSuccessfully(ports);

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.get(PILOT), {
        lastWorkedAt: FROZEN_NOW,
        runs: [{ at: FROZEN_NOW, tokensUsed: tokenCount(42_000) }],
      });
    });

    it("leaves the work recorded even when it could not be opened", async () => {
      const ports = fakePorts();
      ranSuccessfully(ports);
      ports.repoHost.draftPullRequest = async () => {
        throw new Error("pull requests are disabled on this repository");
      };

      await assert.rejects(morningRun(ports), /pull requests are disabled/);

      const state = await ports.store.loadState();
      assert.deepEqual(state.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
    });
  });

  describe("a run that falls over", () => {
    it("still writes state back, since it still spent the morning", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error("docker is not running");
      });
      const saveState = t.mock.method(ports.store, "saveState");

      await assert.rejects(morningRun(ports), /docker is not running/);

      assert.equal(saveState.mock.callCount(), 1);
    });
  });
});

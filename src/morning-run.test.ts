import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { morningRun, type ProjectOutcome } from "./morning-run.ts";
import { repoSlug, tokenCount } from "./ports/index.ts";
import { fakePorts } from "./testing/index.ts";

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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { morningRun } from "./morning-run.ts";
import { fakePorts } from "./testing/index.ts";

describe("morningRun", () => {
  it("reports a dry queue when nothing is registered", async () => {
    const ports = fakePorts();

    const report = await morningRun(ports);

    assert.equal(report.outcome, "dry-queue");
    assert.deepEqual(report.projectsConsidered, []);
    assert.match(report.message, /nothing to do/i);
  });

  it("reports a dry queue when every backlog is empty", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/side-projects-manager");
    ports.store.register("nadav-alon/pilot");

    const report = await morningRun(ports);

    assert.equal(report.outcome, "dry-queue");
    assert.deepEqual(report.projectsConsidered, [
      "nadav-alon/side-projects-manager",
      "nadav-alon/pilot",
    ]);
    assert.match(report.message, /nothing to do/i);
  });

  it("asks the tracker about every registered project", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/side-projects-manager");
    ports.store.register("nadav-alon/pilot");

    await morningRun(ports);

    assert.deepEqual(ports.tracker.listedRepos, [
      "nadav-alon/side-projects-manager",
      "nadav-alon/pilot",
    ]);
  });

  it("never runs an agent when the queue is dry", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/pilot");

    await morningRun(ports);

    assert.deepEqual(ports.sandbox.runs, []);
  });

  it("selects the project it found work in", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/pilot");
    ports.tracker.addEligibleTicket("nadav-alon/pilot", {
      number: 7,
      title: "Add the thing",
    });

    const report = await morningRun(ports);

    assert.equal(report.outcome, "work-selected");
    assert.match(report.message, /nadav-alon\/pilot/);
  });

  it("stops considering projects once one is selected, since an iteration works one project", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/pilot");
    ports.store.register("nadav-alon/side-projects-manager");
    ports.tracker.addEligibleTicket("nadav-alon/pilot", {
      number: 7,
      title: "Add the thing",
    });

    await morningRun(ports);

    assert.deepEqual(ports.tracker.listedRepos, ["nadav-alon/pilot"]);
  });

  it("timestamps the report from the injected clock, not wall time", async () => {
    const ports = fakePorts();
    const startedAt = ports.clock.now();

    const report = await morningRun(ports);

    assert.deepEqual(report.startedAt, startedAt);
  });
});

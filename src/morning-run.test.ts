import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { morningRun } from "./morning-run.ts";
import { fakePorts } from "./testing/index.ts";

describe("morningRun", () => {
  it("reports there was nothing to do when nothing is registered", async () => {
    const ports = fakePorts();

    const report = await morningRun(ports);

    assert.equal(report.outcome, "no-work-available");
    assert.deepEqual(report.projectsConsidered, []);
    assert.match(report.message, /nothing to do/i);
  });

  it("reports there was nothing to do when every backlog is empty", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/side-projects-manager");
    ports.store.register("nadav-alon/pilot");

    const report = await morningRun(ports);

    assert.equal(report.outcome, "no-work-available");
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

  it("never runs an agent when no project has work", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/pilot");

    await morningRun(ports);

    assert.deepEqual(ports.sandbox.runs, []);
  });

  it("reports the project it found work in", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/pilot");
    ports.tracker.addReadyTicket("nadav-alon/pilot", {
      number: 7,
      title: "Add the thing",
    });

    const report = await morningRun(ports);

    assert.equal(report.outcome, "work-available");
    assert.match(report.message, /nadav-alon\/pilot/);
  });

  it("stops looking once a project has work, since a morning works one project", async () => {
    const ports = fakePorts();
    ports.store.register("nadav-alon/pilot");
    ports.store.register("nadav-alon/side-projects-manager");
    ports.tracker.addReadyTicket("nadav-alon/pilot", {
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

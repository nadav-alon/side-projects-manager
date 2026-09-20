import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newProject } from "./new-project.ts";
import { priority, repoSlug } from "./ports/index.ts";
import { FakeRepoHost, fakeNewProjectPorts } from "./testing/index.ts";

const MANAGER = repoSlug("nadav-alon/side-projects-manager");
const PILOT = repoSlug("nadav-alon/pilot");

const PILOT_CHECKOUT = `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`;

const IDEA = { repo: PILOT, description: "A flight log that files itself." };

describe("starting a new project", () => {
  it("creates the repo and clones it to the managed location", async () => {
    const ports = fakeNewProjectPorts();

    const report = await newProject(ports, IDEA);

    assert.deepEqual(ports.host.created, [PILOT]);
    assert.deepEqual(ports.host.clones, [PILOT]);
    assert.equal(report.directory, PILOT_CHECKOUT);
    assert.equal(report.outcome, "created");
  });

  it("installs the harness into the checkout it just made", async () => {
    const ports = fakeNewProjectPorts();

    const report = await newProject(ports, IDEA);

    assert.equal(ports.harness.installs.length, 1);
    assert.equal(ports.harness.installs[0]?.directory, PILOT_CHECKOUT);
    assert.deepEqual(report.scaffolded, [
      "docs/agents/issue-tracker.md",
      "AGENTS.md",
    ]);
  });

  it("scaffolds agent instructions written for this project", async () => {
    const ports = fakeNewProjectPorts();

    await newProject(ports, IDEA);

    const instructions = ports.harness.installs[0]?.instructions ?? "";
    assert.match(instructions, /pilot/);
    assert.match(instructions, /A flight log that files itself\./);
    assert.doesNotMatch(instructions, /side-projects-manager/);
  });

  it("pushes the scaffold, so the repo is not left empty", async () => {
    const ports = fakeNewProjectPorts();

    await newProject(ports, IDEA);

    assert.equal(ports.host.pushes.length, 1);
    assert.equal(ports.host.pushes[0]?.directory, PILOT_CHECKOUT);
  });

  it("commits what it scaffolded and nothing else in the checkout", async () => {
    const ports = fakeNewProjectPorts();

    const report = await newProject(ports, IDEA);

    assert.deepEqual(ports.host.pushes[0]?.paths, report.scaffolded);
  });

  it("appends the project to the registry, behind the ones already there", async () => {
    const ports = fakeNewProjectPorts();
    ports.store.register(MANAGER, { priority: priority(1) });

    await newProject(ports, IDEA);

    assert.deepEqual(await ports.store.loadRegistry(), [
      { repo: MANAGER, paused: false, turbo: false, priority: priority(1) },
      { repo: PILOT, paused: false, turbo: false },
    ]);
  });

  it("leaves an existing project's turbo consent standing when it appends another", async () => {
    const ports = fakeNewProjectPorts();
    ports.store.register(MANAGER, { turbo: true });

    await newProject(ports, IDEA);

    assert.deepEqual(await ports.store.loadRegistry(), [
      { repo: MANAGER, paused: false, turbo: true },
      { repo: PILOT, paused: false, turbo: false },
    ]);
  });

  it("hands off to an interactive grilling session in the checkout", async () => {
    const ports = fakeNewProjectPorts();

    await newProject(ports, IDEA);

    assert.deepEqual(ports.grilling.started, [
      { directory: PILOT_CHECKOUT, existing: false },
    ]);
  });

  it("tells the session when the codebase came before the manager", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);

    await newProject(ports, { ...IDEA, existing: true });

    assert.deepEqual(ports.grilling.started, [
      { directory: PILOT_CHECKOUT, existing: true },
    ]);
  });

  it("grills only once the project is registered, so a walked-away-from session still counts", async () => {
    const ports = fakeNewProjectPorts();
    let registeredWhenGrilled: number | undefined;
    ports.grilling.start = async () => {
      registeredWhenGrilled = (await ports.store.loadRegistry()).length;
    };

    await newProject(ports, IDEA);

    assert.equal(registeredWhenGrilled, 1);
  });

  it("keeps the project when the session could not start at all", async () => {
    const ports = fakeNewProjectPorts();
    ports.grilling.start = async () => {
      throw new Error("spawn claude ENOENT");
    };

    const report = await newProject(ports, IDEA);

    assert.equal(report.grilled, false);
    assert.equal(report.registered, true);
    assert.match(report.message, /spawn claude ENOENT/);
    assert.match(report.message, new RegExp(PILOT_CHECKOUT));
  });

  it("reports a session that ran as one that ran", async () => {
    const ports = fakeNewProjectPorts();

    const report = await newProject(ports, IDEA);

    assert.equal(report.grilled, true);
    assert.doesNotMatch(report.message, /could not start/);
  });

  it("reports what it did in one line naming the project and the checkout", async () => {
    const ports = fakeNewProjectPorts();

    const report = await newProject(ports, IDEA);

    assert.match(report.message, /nadav-alon\/pilot/);
    assert.match(report.message, new RegExp(PILOT_CHECKOUT));
  });
});

describe("registering a repo that already exists", () => {
  it("registers it without creating it", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);

    const report = await newProject(ports, { ...IDEA, existing: true });

    assert.deepEqual(ports.host.created, []);
    assert.deepEqual(ports.host.clones, [PILOT]);
    assert.equal(report.outcome, "existing");
  });

  it("still scaffolds the harness, so the project can join the loop", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);

    await newProject(ports, { ...IDEA, existing: true });

    assert.equal(ports.harness.installs[0]?.directory, PILOT_CHECKOUT);
  });

  it("proposes the harness rather than committing to a branch they had", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);

    const report = await newProject(ports, { ...IDEA, existing: true });

    assert.deepEqual(ports.host.pushes, []);
    assert.equal(ports.host.proposals.length, 1);
    assert.equal(ports.host.proposals[0]?.directory, PILOT_CHECKOUT);
    assert.deepEqual(report.proposal, {
      kind: "proposed",
      branch: "harness",
      url: FakeRepoHost.PROPOSED_PULL_REQUEST,
    });
    assert.match(
      report.message,
      new RegExp(FakeRepoHost.PROPOSED_PULL_REQUEST),
    );
  });

  it("names the files it overwrote in the request, not only in its diff", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);
    ports.harness.overwrites = ["docs/agents/issue-tracker.md"];

    await newProject(ports, { ...IDEA, existing: true });

    const body = ports.host.proposals[0]?.body ?? "";
    assert.match(body, /Overwritten/);
    assert.match(body, /docs\/agents\/issue-tracker\.md/);
    assert.match(body, /Added:[\s\S]*AGENTS\.md/);
  });

  it("registers it paused, so the loop leaves it be until the harness merges", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);

    const report = await newProject(ports, { ...IDEA, existing: true });

    assert.deepEqual(await ports.store.loadRegistry(), [
      { repo: PILOT, paused: true, turbo: false },
    ]);
    assert.match(report.message, /unpause/);
  });

  it("registers it active when its harness was already in place", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);
    ports.host.proposal = () => ({ kind: "unchanged" });

    const report = await newProject(ports, { ...IDEA, existing: true });

    assert.deepEqual(await ports.store.loadRegistry(), [
      { repo: PILOT, paused: false, turbo: false },
    ]);
    assert.doesNotMatch(report.message, /unpause/);
  });

  it("keeps the project when the pull request could not be opened", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);
    ports.host.proposal = (branch) => ({
      kind: "pushed",
      branch,
      failure: "pull requests are disabled",
    });

    const report = await newProject(ports, { ...IDEA, existing: true });

    assert.equal(report.registered, true);
    assert.match(report.message, /pull requests are disabled/);
    assert.match(report.message, /harness/);
  });

  it("refuses a repo that is not there, rather than quietly creating one", async () => {
    const ports = fakeNewProjectPorts();

    await assert.rejects(
      newProject(ports, { ...IDEA, existing: true }),
      /does not exist/,
    );
    assert.deepEqual(ports.host.created, []);
  });
});

describe("refusing to start a project twice", () => {
  it("refuses to create a repo that already exists, and says what to do instead", async () => {
    const ports = fakeNewProjectPorts();
    ports.host.alreadyExists(PILOT);

    await assert.rejects(newProject(ports, IDEA), /already exists/);
    assert.deepEqual(ports.host.clones, []);
  });

  it("leaves the registry as it stands when the project is registered already", async () => {
    const ports = fakeNewProjectPorts();
    ports.store.register(PILOT, { paused: true });
    ports.host.alreadyExists(PILOT);

    const report = await newProject(ports, { ...IDEA, existing: true });

    assert.deepEqual(await ports.store.loadRegistry(), [
      { repo: PILOT, paused: true, turbo: false },
    ]);
    assert.match(report.message, /already registered/i);
  });
});

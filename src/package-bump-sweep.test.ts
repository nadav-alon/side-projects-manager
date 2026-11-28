import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageBumpSweep } from "./package-bump-sweep.ts";
import {
  bumpTicketTitle,
  ENHANCEMENT_LABEL,
  pullRequestUrl,
  READY_FOR_AGENT_LABEL,
  releaseTag,
  repoSlug,
  TURBOABLE_LABEL,
} from "./ports/index.ts";
import { FakeIssueTracker, FakeRepoHost } from "./testing/index.ts";

const UI = repoSlug("nadav-alon/household-ui");
const DATA = repoSlug("nadav-alon/data-platform");
const CATALOGUE = repoSlug("nadav-alon/home-catalogue");
const RECIPES = repoSlug("nadav-alon/recipes");

function manifest(dependencies: Record<string, string>): string {
  return JSON.stringify({ dependencies });
}

function arrange() {
  const repoHost = new FakeRepoHost();
  const tracker = new FakeIssueTracker();
  repoHost.setLatestRelease(UI, releaseTag("v0.5.1"));
  repoHost.setLatestRelease(DATA, releaseTag("v0.27.0"));
  return { repoHost, tracker, ports: { repoHost, tracker } };
}

describe("packageBumpSweep", () => {
  it("opens one bump ticket in each project pinning an older tag of a package", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    repoHost.setFile(RECIPES, "package.json", manifest({ "data-platform": "github:nadav-alon/data-platform#v0.17.0" }));

    const outcomes = await packageBumpSweep(ports, [UI, DATA, CATALOGUE, RECIPES]);

    assert.deepEqual(
      outcomes.map((o) => [o.publisher, o.project, o.result.kind]),
      [
        [UI, CATALOGUE, "opened"],
        [DATA, RECIPES, "opened"],
      ],
    );
    assert.deepEqual(
      tracker.bumpTickets.map((b) => [b.ticket.repo, b.ticket.title]),
      [
        [CATALOGUE, bumpTicketTitle("household-ui", releaseTag("v0.5.1"))],
        [RECIPES, bumpTicketTitle("data-platform", releaseTag("v0.27.0"))],
      ],
    );
    assert.match(tracker.bumpTickets[0]?.body ?? "", /v0\.1\.0/);
  });

  it("files bump tickets ready-for-agent and turboable", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));

    await packageBumpSweep(ports, [UI, CATALOGUE]);

    const ticket = tracker.bumpTickets[0]?.ticket;
    assert.ok(ticket);
    assert.equal(tracker.carriesLabel(ticket, READY_FOR_AGENT_LABEL), true);
    assert.equal(tracker.carriesLabel(ticket, TURBOABLE_LABEL), true);
    assert.equal(tracker.carriesLabel(ticket, ENHANCEMENT_LABEL), true);
  });

  it("files nothing for a project already on the release or not depending on the package", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.5.1" }));
    repoHost.setFile(RECIPES, "package.json", manifest({ left: "^1.0.0" }));

    const outcomes = await packageBumpSweep(ports, [UI, DATA, CATALOGUE, RECIPES]);

    assert.deepEqual(outcomes, []);
    assert.deepEqual(tracker.bumpTickets, []);
  });

  it("files nothing for a package that has published no release, or a project with no manifest", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(UI, "package.json", manifest({ "home-catalogue": "github:nadav-alon/home-catalogue#v0.1.0" }));

    await packageBumpSweep(ports, [UI, DATA, CATALOGUE]);

    assert.deepEqual(tracker.bumpTickets, []);
  });

  it("opens no second ticket while the project's bump ticket is open", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));

    await packageBumpSweep(ports, [UI, CATALOGUE]);
    const again = await packageBumpSweep(ports, [UI, CATALOGUE]);

    assert.deepEqual(again, []);
    assert.equal(tracker.bumpTickets.length, 1);
    assert.deepEqual(tracker.rewrittenTickets, []);
  });

  it("rewrites the open bump ticket for a later release rather than stacking another", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    await packageBumpSweep(ports, [UI, CATALOGUE]);

    repoHost.setLatestRelease(UI, releaseTag("v0.6.0"));
    const outcomes = await packageBumpSweep(ports, [UI, CATALOGUE]);

    assert.deepEqual(outcomes.map((o) => o.result.kind), ["updated"]);
    assert.equal(tracker.bumpTickets.length, 1);
    assert.equal(tracker.rewrittenTickets[0]?.title, "Bump household-ui to v0.6.0");
    assert.match(tracker.rewrittenTickets[0]?.body ?? "", /v0\.6\.0/);
  });

  it("closes the open bump ticket, with a comment, once the pin reaches the latest release", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    await packageBumpSweep(ports, [UI, CATALOGUE]);
    const ticket = tracker.bumpTickets[0]?.ticket;

    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.5.1" }));
    const outcomes = await packageBumpSweep(ports, [UI, CATALOGUE]);

    assert.deepEqual(outcomes.map((o) => [o.project, o.result.kind]), [[CATALOGUE, "closed"]]);
    assert.equal(tracker.closedBumpTickets.length, 1);
    assert.deepEqual(tracker.closedBumpTickets[0]?.ticket, ticket);
    assert.match(tracker.closedBumpTickets[0]?.comment ?? "", /v0\.5\.1/);
    assert.deepEqual(await packageBumpSweep(ports, [UI, CATALOGUE]), []);
  });

  it("closes the open bump ticket for a pin past the latest release, and none where no bump ticket is open", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    await packageBumpSweep(ports, [UI, CATALOGUE]);
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.9.0" }));
    repoHost.setFile(RECIPES, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.5.1" }));

    const outcomes = await packageBumpSweep(ports, [UI, CATALOGUE, RECIPES]);

    assert.deepEqual(outcomes.map((o) => [o.project, o.result.kind]), [[CATALOGUE, "closed"]]);
    assert.equal(tracker.closedBumpTickets.length, 1);
    assert.match(tracker.closedBumpTickets[0]?.comment ?? "", /v0\.9\.0/);
    assert.match(tracker.closedBumpTickets[0]?.comment ?? "", /v0\.5\.1/);
  });

  it("refuses where a truncated backlog may hide the open bump ticket of a project already on the latest release", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.5.1" }));
    tracker.truncateBacklog(CATALOGUE);

    const outcomes = await packageBumpSweep(ports, [UI, CATALOGUE]);

    assert.deepEqual(outcomes.map((o) => [o.project, o.result.kind]), [[CATALOGUE, "refused"]]);
    assert.deepEqual(tracker.closedBumpTickets, []);
  });

  it("opens a fresh ticket once the earlier one is no longer open", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    await packageBumpSweep(ports, [UI, CATALOGUE]);
    const first = tracker.bumpTickets[0]?.ticket;
    assert.ok(first);
    await tracker.closeRebaseTicket(
      { ...first, pullRequest: { kind: "rebase", url: pullRequestUrl("https://github.com/nadav-alon/home-catalogue/pull/3") } },
      "done",
    );

    await packageBumpSweep(ports, [UI, CATALOGUE]);

    assert.equal(tracker.bumpTickets.length, 2);
  });

  it("carries a refusal as an outcome and goes on to the next project", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    repoHost.setFile(RECIPES, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    const create = tracker.createBumpTicket.bind(tracker);
    tracker.createBumpTicket = async (repo, text) => {
      if (repo === CATALOGUE) {
        throw new Error("HTTP 403");
      }
      return create(repo, text);
    };

    const outcomes = await packageBumpSweep(ports, [UI, CATALOGUE, RECIPES]);

    assert.deepEqual(
      outcomes.map((o) => [o.project, o.result.kind]),
      [
        [CATALOGUE, "refused"],
        [RECIPES, "opened"],
      ],
    );
  });

  it("refuses rather than opening a second ticket where a truncated backlog may hide the open one", async () => {
    const { repoHost, tracker, ports } = arrange();
    repoHost.setFile(CATALOGUE, "package.json", manifest({ "household-ui": "github:nadav-alon/household-ui#v0.1.0" }));
    tracker.truncateBacklog(CATALOGUE);

    const outcomes = await packageBumpSweep(ports, [UI, CATALOGUE]);

    assert.deepEqual(
      outcomes.map((o) => [o.project, o.result.kind]),
      [[CATALOGUE, "refused"]],
    );
    assert.deepEqual(tracker.bumpTickets, []);
  });
});

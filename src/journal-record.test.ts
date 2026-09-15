import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { invocationClosing } from "./journal-record.ts";
import { morningLoop } from "./morning-run.ts";
import {
  branch,
  issueNumber,
  repoSlug,
  tokenCount,
} from "./ports/index.ts";
import { LIMIT_REFUSAL, fakePorts, spent } from "./testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const MANAGER = repoSlug("nadav-alon/side-projects-manager");
const CLOSED_AT = new Date("2026-01-01T08:00:00.000Z");

describe("invocationClosing", () => {
  it("closes a dry queue with no projects and no stand-down reason", async () => {
    const report = await morningLoop(fakePorts());

    assert.deepEqual(invocationClosing(report, CLOSED_AT), {
      closedAt: CLOSED_AT,
      outcome: "dry-queue",
      projects: [],
    });
  });

  it("sums what one project's runs together cost across the invocation", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "First",
    });
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(8),
      title: "Second",
    });
    ports.sandbox.result = (ticket) => ({
      kind: "finished",
      branch: branch(`issue-${ticket.number}`),
      commits: [],
      output: "",
      tokensUsed: tokenCount(ticket.number === 7 ? 1_000 : 2_000),
    });

    const report = await morningLoop(ports);
    const closing = invocationClosing(report, CLOSED_AT);

    assert.equal(closing.outcome, "work-selected");
    assert.deepEqual(closing.projects, [
      { repo: PILOT, tokensUsed: tokenCount(3_000) },
    ]);
  });

  it("names only the projects actually worked, not every registered one", async () => {
    const ports = fakePorts();
    ports.store.register(MANAGER);
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "First",
    });
    ports.sandbox.result = (ticket) => ({
      kind: "finished",
      branch: branch(`issue-${ticket.number}`),
      commits: [],
      output: "",
      tokensUsed: tokenCount(500),
    });

    const report = await morningLoop(ports);

    assert.deepEqual(invocationClosing(report, CLOSED_AT).projects, [
      { repo: PILOT, tokensUsed: tokenCount(500) },
    ]);
  });

  it("leaves out a ticket handed back for its model labels, since nothing ran and nothing was spent", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    const ticket = ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "First",
    });
    ports.tracker.addLabel(ticket, "model:opus");
    ports.tracker.addLabel(ticket, "model:haiku");

    const report = await morningLoop(ports);

    assert.deepEqual(invocationClosing(report, CLOSED_AT).projects, []);
  });

  it("records a project an iteration attempted even when the sandbox itself broke, with nothing spent", async (t) => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "First",
    });
    t.mock.method(ports.sandbox, "run", async () => {
      throw new Error("docker is not running");
    });

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(invocationClosing(report, CLOSED_AT).projects, [
      { repo: PILOT, tokensUsed: tokenCount(0) },
    ]);
  });

  it("records why the invocation stood down before any run started", async () => {
    const SPENDABLE_THIS_WEEK = 250_000_000;
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "First",
    });
    ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

    const report = await morningLoop(ports);
    const closing = invocationClosing(report, CLOSED_AT);

    assert.equal(closing.outcome, "stood-down");
    assert.deepEqual(closing.projects, []);
    assert.match(closing.standDownReason ?? "", /weekly-reserve/);
  });

  it("records both what a morning worked and why it then stood down", async () => {
    const SPENDABLE_THIS_WEEK = 250_000_000;
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "First",
    });
    ports.store.register(MANAGER);
    ports.tracker.addEligibleTicket(MANAGER, {
      number: issueNumber(3),
      title: "Second",
    });
    // Leaves only 1,000 tokens of reserve headroom; one run of 2,000 blows it.
    ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK - 1_000 }));
    ports.sandbox.result = () => ({
      kind: "finished",
      branch: branch("issue-7"),
      commits: [],
      output: "",
      tokensUsed: tokenCount(2_000),
    });

    const report = await morningLoop(ports);
    const closing = invocationClosing(report, CLOSED_AT);

    assert.equal(closing.outcome, "work-selected");
    assert.deepEqual(closing.projects, [
      { repo: PILOT, tokensUsed: tokenCount(2_000) },
    ]);
    assert.match(closing.standDownReason ?? "", /weekly-reserve/);
  });

  it("records a provider limit refusal's own words as the stand-down reason", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "First",
    });
    ports.sandbox.result = () => ({
      kind: "limit-refused",
      branch: branch("issue-7"),
      commits: [],
      words: LIMIT_REFUSAL,
      tokensUsed: tokenCount(1_500),
    });

    const report = await morningLoop(ports);
    const closing = invocationClosing(report, CLOSED_AT);

    assert.equal(closing.standDownReason, LIMIT_REFUSAL);
    assert.deepEqual(closing.projects, [
      { repo: PILOT, tokensUsed: tokenCount(1_500) },
    ]);
  });

  it("records an invocation that never got off the ground, with nothing worked", async (t) => {
    const ports = fakePorts();
    t.mock.method(ports.store, "loadRegistry", async () => {
      throw new Error('registry.json: project 1: "repo" must be a repo slug');
    });

    const report = await morningLoop(ports);
    const closing = invocationClosing(report, CLOSED_AT);

    assert.equal(closing.outcome, "invocation-failed");
    assert.deepEqual(closing.projects, []);
    assert.equal(closing.standDownReason, undefined);
  });

  it("closes with exactly the instant it is given", async () => {
    const report = await morningLoop(fakePorts());
    const closedAt = new Date("2026-06-15T21:00:00.000Z");

    assert.deepEqual(invocationClosing(report, closedAt).closedAt, closedAt);
  });
});

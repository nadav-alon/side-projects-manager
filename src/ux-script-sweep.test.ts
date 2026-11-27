import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { issueNumber, repoSlug, UX_SCRIPT_TICKET_TITLE } from "./ports/index.ts";
import { FakeIssueTracker } from "./testing/fake-issue-tracker.ts";
import { FakeRepoHost } from "./testing/fake-repo-host.ts";
import { uxScriptSweep } from "./ux-script-sweep.ts";

const APP = repoSlug("nadav-alon/app");

describe("uxScriptSweep", () => {
  it("files one ready-for-agent, turboable, size:M ticket where there is no ux script", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    repoHost.setNpmScripts(APP, ["dev", "build"]);

    const outcome = await uxScriptSweep({ tracker, repoHost }, APP);

    assert.equal(outcome.result.kind, "filed");
    assert.equal(tracker.uxScriptTickets.length, 1);
    assert.equal(tracker.uxScriptTickets[0]?.title, UX_SCRIPT_TICKET_TITLE);
    const { issues } = await tracker.listOpenIssues(APP);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0]?.ticket.sizeLabel, { kind: "declared", size: "M" });
    const filed = outcome.result.kind === "filed" ? outcome.result.ticket : undefined;
    assert.ok(filed);
    for (const label of ["ready-for-agent", "size:M", "turboable"]) {
      assert.ok(tracker.carriesLabel(filed, label), `the ticket should carry ${label}`);
    }
  });

  it("files none while one is open", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    tracker.addEligibleTicket(APP, { number: issueNumber(4), title: UX_SCRIPT_TICKET_TITLE });

    const outcome = await uxScriptSweep({ tracker, repoHost }, APP);

    assert.deepEqual(outcome.result, { kind: "unchanged" });
    assert.deepEqual(tracker.uxScriptTickets, []);
  });

  it("files none when the open issues read was truncated", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    tracker.truncateBacklog(APP);

    const outcome = await uxScriptSweep({ tracker, repoHost }, APP);

    assert.deepEqual(outcome.result, { kind: "unchanged" });
    assert.deepEqual(tracker.uxScriptTickets, []);
  });

  it("files none for a project that has a ux script", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    repoHost.setNpmScripts(APP, ["ux"]);

    const outcome = await uxScriptSweep({ tracker, repoHost }, APP);

    assert.deepEqual(outcome.result, { kind: "unchanged" });
    assert.deepEqual(tracker.uxScriptTickets, []);
  });

  it("answers refused rather than throwing when a read fails", async () => {
    const tracker = new FakeIssueTracker();
    const repoHost = new FakeRepoHost();
    repoHost.hasNpmScript = async () => {
      throw new Error("boom");
    };

    const outcome = await uxScriptSweep({ tracker, repoHost }, APP);

    assert.deepEqual(outcome.result, { kind: "refused", error: "boom" });
  });
});

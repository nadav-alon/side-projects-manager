import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { ghIssueTracker } from "./gh-issue-tracker.ts";
import { READY_FOR_AGENT_LABEL, repoSlug } from "../ports/index.ts";

const execFileAsync = promisify(execFile);

// The manager's own repo: a real tracker with a real, changing mix of
// open/closed and labelled/unlabelled issues, so the adapter is verified
// against the tracker it actually talks to rather than a repo built for the
// test.
const MANAGER = repoSlug("nadav-alon/side-projects-manager");

// A public repo the developer doesn't own, guaranteed to carry no
// ready-for-agent issues. Verifies an empty backlog is not an error. Also
// referenced from `morning-run.test.ts`, for the same reason.
const EMPTY = repoSlug("octocat/Hello-World");

type RawIssue = {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
};

async function fetchIssue(repo: string, number: number): Promise<RawIssue> {
  const { stdout } = await execFileAsync("gh", [
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,state,labels",
  ]);
  return JSON.parse(stdout) as RawIssue;
}

describe("ghIssueTracker", () => {
  it("returns exactly the repo's open issues carrying the ready-for-agent label", async () => {
    const { stdout } = await execFileAsync("gh", [
      "issue",
      "list",
      "--repo",
      MANAGER,
      "--state",
      "all",
      "--json",
      "number,title,state,labels",
    ]);
    const all = JSON.parse(stdout) as RawIssue[];

    const closedButLabelled = all.find(
      (issue) =>
        issue.state === "CLOSED" &&
        issue.labels.some((label) => label.name === READY_FOR_AGENT_LABEL),
    );
    const openButUnlabelled = all.find(
      (issue) =>
        issue.state === "OPEN" &&
        !issue.labels.some((label) => label.name === READY_FOR_AGENT_LABEL),
    );
    // The fixture repo must actually exercise both exclusion cases, or the
    // assertions below would pass whether or not the adapter filters
    // anything.
    assert.ok(
      closedButLabelled,
      "fixture repo needs a closed, labelled issue to prove state is filtered",
    );
    assert.ok(
      openButUnlabelled,
      "fixture repo needs an open, unlabelled issue to prove the label is filtered",
    );

    const tickets = await ghIssueTracker().listEligibleTickets(MANAGER);
    const numbers = tickets.map((ticket) => ticket.number);

    // Excluded by state, excluded by label: neither belongs in the result,
    // checked against the fixtures found above rather than a JS
    // reimplementation of the adapter's own filter.
    assert.ok(!numbers.includes(closedButLabelled.number));
    assert.ok(!numbers.includes(openButUnlabelled.number));

    assert.ok(tickets.length > 0, "fixture repo needs at least one eligible issue");
    for (const ticket of tickets) {
      // Verified independently via `gh issue view`, not `gh issue list`'s own
      // filtering flags, so a bug in those flags can't make this pass anyway.
      const issue = await fetchIssue(MANAGER, ticket.number);
      assert.equal(issue.state, "OPEN");
      assert.ok(issue.labels.some((label) => label.name === READY_FOR_AGENT_LABEL));
      assert.equal(ticket.title, issue.title);
      assert.equal(ticket.repo, MANAGER);
    }
  });

  it("returns an empty backlog for a project with no eligible tickets, without an error", async () => {
    const tickets = await ghIssueTracker().listEligibleTickets(EMPTY);

    assert.deepEqual(tickets, []);
  });
});

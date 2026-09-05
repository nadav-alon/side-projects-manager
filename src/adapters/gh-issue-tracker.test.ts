import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { ghIssueTracker } from "./gh-issue-tracker.ts";
import { READY_FOR_AGENT_LABEL, repoSlug, type Ticket } from "../ports/index.ts";

const execFileAsync = promisify(execFile);

// The manager's own repo: a real tracker with a real, changing mix of
// open/closed and labelled/unlabelled issues, so the adapter is verified
// against the tracker it actually talks to rather than a repo built for the
// test.
const MANAGER = repoSlug("nadav-alon/side-projects-manager");

// A public repo the developer doesn't own, guaranteed to carry no
// ready-for-agent issues. Verifies an empty backlog is not an error.
const EMPTY = repoSlug("octocat/Hello-World");

function byNumber(a: Ticket, b: Ticket): number {
  return a.number - b.number;
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
    const all = JSON.parse(stdout) as {
      number: number;
      title: string;
      state: string;
      labels: { name: string }[];
    }[];
    const isEligible = (issue: (typeof all)[number]): boolean =>
      issue.state === "OPEN" &&
      issue.labels.some((label) => label.name === READY_FOR_AGENT_LABEL);

    // The fixture repo must actually exercise both exclusion cases, or this
    // test would pass whether or not the adapter filters anything.
    assert.ok(
      all.some(
        (issue) =>
          issue.state === "CLOSED" &&
          issue.labels.some((label) => label.name === READY_FOR_AGENT_LABEL),
      ),
      "fixture repo needs a closed, labelled issue to prove state is filtered",
    );
    assert.ok(
      all.some(
        (issue) =>
          issue.state === "OPEN" &&
          !issue.labels.some((label) => label.name === READY_FOR_AGENT_LABEL),
      ),
      "fixture repo needs an open, unlabelled issue to prove the label is filtered",
    );

    const expected: Ticket[] = all
      .filter(isEligible)
      .map((issue) => ({ repo: MANAGER, number: issue.number, title: issue.title }))
      .sort(byNumber);

    const tickets = await ghIssueTracker().listEligibleTickets(MANAGER);

    assert.deepEqual([...tickets].sort(byNumber), expected);
  });

  it("returns an empty backlog for a project with no eligible tickets, without an error", async () => {
    const tickets = await ghIssueTracker().listEligibleTickets(EMPTY);

    assert.deepEqual(tickets, []);
  });
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { ghIssueTracker } from "./gh-issue-tracker.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  modelLabelOf,
  modelName,
  pullRequestUrl,
  repoSlug,
  type ReviewTicket,
  type Ticket,
} from "../ports/index.ts";
import { callWith, recordingGh, tempHome, valueOf } from "../testing/index.ts";

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

    const { tickets } = await ghIssueTracker().listEligibleTickets(MANAGER);
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
      assert.deepEqual(
        ticket.modelLabel,
        modelLabelOf(issue.labels.map((label) => label.name)),
      );
    }
  });

  it("returns an empty backlog for a project with no eligible tickets, without an error", async () => {
    const { tickets } = await ghIssueTracker().listEligibleTickets(EMPTY);

    assert.deepEqual(tickets, []);
  });

  it("carries how many of an eligible ticket's sub-issues are still open", async () => {
    const { stdout } = await execFileAsync("gh", [
      "issue",
      "list",
      "--repo",
      MANAGER,
      "--state",
      "open",
      "--label",
      READY_FOR_AGENT_LABEL,
      "--json",
      "number,subIssuesSummary",
    ]);
    const all = JSON.parse(stdout) as {
      number: number;
      subIssuesSummary: { total: number; completed: number };
    }[];

    const brokenOut = all.find(
      (issue) => issue.subIssuesSummary.total > issue.subIssuesSummary.completed,
    );
    const whole = all.find(
      (issue) => issue.subIssuesSummary.total <= issue.subIssuesSummary.completed,
    );
    // The fixture repo must exercise both, or the assertions below would pass
    // whether or not the adapter reads `subIssuesSummary` at all.
    assert.ok(
      brokenOut,
      "fixture repo needs an eligible issue with an open sub-issue",
    );
    assert.ok(
      whole,
      "fixture repo needs an eligible issue with no open sub-issues",
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(MANAGER);

    const brokenOutTicket = tickets.find((t) => t.number === brokenOut.number);
    assert.equal(
      brokenOutTicket?.openSubIssues,
      brokenOut.subIssuesSummary.total - brokenOut.subIssuesSummary.completed,
    );

    const wholeTicket = tickets.find((t) => t.number === whole.number);
    assert.equal(wholeTicket?.openSubIssues, undefined);
  });
});

/**
 * Publishing the invocation's summary. Unlike the read path above, this one
 * writes: a real call would leave a real issue behind on every test run,
 * and in the manager's own repo rather than a fixture's. So `gh` is a
 * recording script on PATH, and what this adapter owes the developer — one
 * issue, with the title and body it was given, named to no `--repo` at all —
 * is asserted from the arguments it was called with.
 */
describe("ghIssueTracker.publishSummary", () => {
  it("creates one issue, naming no repo of its own", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().publishSummary("Morning run — 2026-01-01", "Nothing to do.");

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create, "the summary should be created with `gh issue create`");
    assert.equal(valueOf(create, "--title"), "Morning run — 2026-01-01");
    assert.equal(valueOf(create, "--body"), "Nothing to do.");
    // No `--repo`: the tracker's other writes all name one, explicitly,
    // because they land in a project. This is the one write that always
    // lands in the tracker's own, and `gh` resolves that from the checkout
    // it is run in when nothing overrides it.
    assert.equal(valueOf(create, "--repo"), undefined);
  });

  it("creates the issue in the manager home, whatever the working directory", async (t) => {
    const home = await tempHome("manager-home");
    const recorded = path.join(await tempHome("gh-cwd"), "cwd");
    await recordingGh(t, `pwd -P > ${recorded}`);

    await ghIssueTracker(home).publishSummary(
      "Morning run — 2026-01-01",
      "Nothing to do.",
    );

    // The whole of the fix: `gh` resolves the repo from where it runs, and
    // where it runs is the manager's own checkout rather than wherever the
    // trigger happened to start. Cron starts it in the developer's home
    // directory, which is no repository at all — an invocation that worked
    // would then lose its summary to `gh` refusing to create an issue.
    assert.equal(
      (await readFile(recorded, "utf8")).trim(),
      await realpath(home),
    );
  });
});

/**
 * Opening the review a draft pull request is handed over as.
 *
 * Unlike the read path above, this one writes: run against the real tracker it
 * would leave an issue behind on every test run. So `gh` is a recording script
 * on PATH, and what this adapter owes the developer — an eligible sub-issue
 * naming the pull request, and a ticket it never touched — is asserted from
 * the arguments it was called with.
 */
describe("ghIssueTracker.createReviewTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  const TICKET: Ticket = {
    repo: PILOT,
    number: 7,
    title: "Add the thing",
  };

  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/12",
  );
  const REVIEW_URL = "https://github.com/nadav-alon/pilot/issues/42";
  /** The review's database id, which is what the sub-issues endpoint takes. */
  const REVIEW_ID = "2159872455";

  /** A tracker where creating, reading back and linking all succeed. */
  const WORKING = [
    `case "$1 $2" in`,
    `  "issue create") echo ${REVIEW_URL} ;;`,
    `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
    `  *) : ;;`,
    `esac`,
  ].join("\n");

  it("creates it in the project's own repo, carrying ready-for-agent", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create, "the review should be created with `gh issue create`");
    assert.equal(valueOf(create, "--repo"), PILOT);
    assert.equal(valueOf(create, "--label"), READY_FOR_AGENT_LABEL);
  });

  it("creates the ready-for-agent label first, since a project may have none", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    // `gh issue create --label` fails outright against a label that does not
    // exist, and `gh issue list --label` does not, so a project can reach here
    // without one — after the pull request is already open.
    const calls = await gh.calls();
    const label = callWith(calls, "label", "create");
    assert.ok(label, "the label should be created");
    assert.ok(label.includes(READY_FOR_AGENT_LABEL));
    assert.equal(valueOf(label, "--repo"), PILOT);
    const create = callWith(calls, "issue", "create");
    assert.ok(create);
    assert.ok(
      calls.indexOf(label) < calls.indexOf(create),
      "the label should exist before the review that carries it",
    );
  });

  it("opens the review even where the label is already there", async (t) => {
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "label create") echo "label already exists" >&2; exit 1 ;;`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    // Every project the developer triages by hand answers that way, which is
    // to say: the label exists, which is all this asked for.
    const review = await ghIssueTracker().createReviewTicket(
      TICKET,
      PULL_REQUEST,
    );

    assert.equal(review.number, 42);
  });

  it("names the pull request to review, and the ticket that earned it", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.match(valueOf(create, "--title") ?? "", /#7/);

    // The URL, which is the one thing a reviewing run cannot work out for
    // itself, and the ticket that earned the review.
    const body = valueOf(create, "--body") ?? "";
    assert.match(body, /pull\/12/);
    assert.match(body, /#7/);
  });

  it("answers with the review it opened", async (t) => {
    const gh = await recordingGh(t, WORKING);

    const review = await ghIssueTracker().createReviewTicket(
      TICKET,
      PULL_REQUEST,
    );

    assert.equal(review.repo, PILOT);
    assert.equal(review.number, 42);
    assert.match(review.title, /#7/);
  });

  it("hangs it off the ticket with the tracker's own sub-issue relationship", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const link = callWith(await gh.calls(), "api", "--method", "POST");
    assert.ok(link, "the review should be linked as a sub-issue");
    // The parent's endpoint, and the child's database id rather than its
    // number, which is what that endpoint actually takes.
    assert.ok(link.includes("repos/nadav-alon/pilot/issues/7/sub_issues"));
    assert.equal(valueOf(link, "-F"), `sub_issue_id=${REVIEW_ID}`);
  });

  it("falls back to a parent reference in its body where sub-issues are unavailable", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
        `  "api --method") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const review = await ghIssueTracker().createReviewTicket(
      TICKET,
      PULL_REQUEST,
    );

    const edit = callWith(await gh.calls(), "issue", "edit");
    assert.ok(edit, "the review's body should carry the reference instead");
    assert.equal(valueOf(edit, "--repo"), PILOT);
    assert.ok(edit.includes("42"));
    // The reference is added to the body, not substituted for it: the review
    // still has to say what it is asking for.
    const body = valueOf(edit, "--body") ?? "";
    assert.match(body, /^Part of #7\./);
    assert.match(body, /pull\/12/);
    // Still the review it opened: the relationship is written differently, not
    // the ticket.
    assert.equal(review.number, 42);
  });

  it("does not guess at an issue id the tracker did not give it", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        // An id lookup that succeeds and answers with nothing, which is what a
        // `--jq` selecting a field that isn't there comes to.
        `  "api repos/nadav-alon/pilot/issues/42") echo "" ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      /"id" was not an issue id: ""/,
    );

    // Nothing is POSTed on a blank answer rather than whatever `Number("")`
    // comes to, and nothing is written into a body either: an answer the
    // tracker mangled is not a tracker that has no sub-issues.
    const calls = await gh.calls();
    assert.equal(callWith(calls, "api", "--method", "POST"), undefined);
    assert.equal(callWith(calls, "issue", "edit"), undefined);
  });

  it("refuses rather than downgrade the link when the tracker will not answer", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
        // A tracker that has sub-issues and would not be asked: a token
        // without the scope, a rate limit, a proxy in the way.
        `  "api --method") echo "gh: Forbidden (HTTP 403)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      /HTTP 403/,
    );

    // The body reference is for a tracker that cannot do sub-issues at all.
    // Written here it would permanently downgrade a relationship that was one
    // retry away, and say nothing about the refusal.
    assert.equal(callWith(await gh.calls(), "issue", "edit"), undefined);
  });

  it("never edits or closes the ticket it reviews", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
        `  "api --method") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    // The fallback path, which is the one that writes to an issue body: even
    // there, the issue written to is the review and never its parent.
    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const calls = await gh.calls();
    assert.equal(callWith(calls, "issue", "close"), undefined);
    assert.equal(callWith(calls, "issue", "edit", "7"), undefined);
    assert.equal(callWith(calls, "issue", "comment"), undefined);
  });

  it("says so when the tracker answers with something other than the new issue", async (t) => {
    await recordingGh(t, `echo "Creating issue in nadav-alon/pilot"`);

    // Linking is by number, so a number that was never read is not a number
    // to guess at: better to stop than to hang the review off the wrong issue.
    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      /expected the new issue's URL/,
    );
  });

  it("says so when linking fails after the review was opened", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  *) echo "denied" >&2; exit 1 ;;`,
        `esac`,
      ].join("\n"),
    );

    // The morning's work is not lost — the review is open and eligible — but
    // it is floating free of its parent, and only this error says so. It names
    // the pull request too: the morning pushed a branch and opened one, and
    // this is the only place the developer is told where they are.
    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      /Opened #42 in nadav-alon\/pilot .* could not link it to #7/s,
    );
    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      new RegExp(PULL_REQUEST),
    );
  });
});

/**
 * The one write path the failure policy rests on. Checked against the
 * arguments `gh` is handed, since a real hand-back would comment on and
 * relabel a real ticket every time the suite ran.
 */
describe("ghIssueTracker.handBack", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  const TICKET: Ticket = {
    repo: PILOT,
    number: 7,
    title: "Add the thing",
  };

  const COMMENT = "The morning loop ran this ticket and the agent gave up.\n\nWhy it stopped: red tests";

  /** A tracker where every call succeeds. */
  const WORKING = ":";

  it("comments on the ticket, in its own repo, saying what it was given", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().handBack(TICKET, COMMENT);

    const comment = callWith(await gh.calls(), "issue", "comment");
    assert.ok(comment, "the ticket should be commented on");
    assert.ok(comment.includes("7"));
    assert.equal(valueOf(comment, "--repo"), PILOT);
    // Whole, not its first line: the comment is several paragraphs.
    assert.equal(valueOf(comment, "--body"), COMMENT);
  });

  it("takes ready-for-agent off, so tomorrow cannot select it", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().handBack(TICKET, COMMENT);

    const removed = callWith(await gh.calls(), "--remove-label");
    assert.ok(removed, "ready-for-agent should be removed");
    assert.equal(valueOf(removed, "--remove-label"), READY_FOR_AGENT_LABEL);
    assert.equal(valueOf(removed, "--repo"), PILOT);
  });

  it("puts ready-for-human on, creating the label first since nothing else does", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().handBack(TICKET, COMMENT);

    const calls = await gh.calls();
    const label = callWith(calls, "label", "create", READY_FOR_HUMAN_LABEL);
    const added = callWith(calls, "--add-label");
    assert.ok(label, "ready-for-human should be created");
    assert.equal(valueOf(label, "--repo"), PILOT);
    assert.ok(added, "ready-for-human should be added");
    assert.equal(valueOf(added, "--add-label"), READY_FOR_HUMAN_LABEL);
    assert.ok(
      calls.indexOf(label) < calls.indexOf(added),
      "the label should exist before it is added",
    );
  });

  it("comments, then unqueues, then relabels — the order they degrade best in", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().handBack(TICKET, COMMENT);

    const calls = await gh.calls();
    const order = [
      callWith(calls, "issue", "comment"),
      callWith(calls, "--remove-label"),
      callWith(calls, "--add-label"),
    ].map((call) => (call === undefined ? -1 : calls.indexOf(call)));
    assert.ok(order.every((at) => at !== -1), "all three calls should happen");
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  it("relabels a ticket in a project that already has the label", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "label create") echo "label already exists" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    await ghIssueTracker().handBack(TICKET, COMMENT);

    assert.ok(callWith(await gh.calls(), "--add-label"));
  });

  it("still counts as handed back when only ready-for-human is refused", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$*" in`,
        `  *--add-label*) echo "could not add label" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );
    t.mock.method(console, "warn", () => undefined);

    // Commented on and out of the queue is the guarantee. Throwing here would
    // have the loop tell the developer to put ready-for-agent back on.
    await ghIssueTracker().handBack(TICKET, COMMENT);

    const calls = await gh.calls();
    assert.ok(callWith(calls, "issue", "comment"));
    assert.ok(callWith(calls, "--remove-label"));
  });

  it("fails the hand-back when the ticket cannot be taken out of the queue", async (t) => {
    await recordingGh(
      t,
      [
        `case "$*" in`,
        `  *--remove-label*) echo "HTTP 403" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    // Still eligible, so still due to come round: the one outcome the caller
    // has to hear about, because the developer has to relabel it by hand.
    await assert.rejects(ghIssueTracker().handBack(TICKET, COMMENT));
  });
});

/**
 * One issue as `gh issue list` answers for it: every field the adapter asks
 * for, filled in as a ticket with none of it — no body, sub-issues, blockers
 * or labels — unless `fields` names its own. Each listing test sets only the
 * fields it is about.
 */
function rawIssue(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    body: "",
    subIssuesSummary: { total: 0, completed: 0 },
    blockedBy: { nodes: [], totalCount: 0 },
    labels: [],
    ...fields,
  };
}

// `printf '%s'` rather than `echo`: `/bin/sh`'s builtin `echo` interprets
// `\n` in its argument on some shells (dash's is XSI-conformant), turning
// the `\n` a body with a blank line in it serializes to back into a raw
// newline and breaking the JSON `gh` is meant to answer with.
function issues(rawIssues: Record<string, unknown>[]): string {
  return `printf '%s' '${JSON.stringify(rawIssues.map(rawIssue))}'`;
}

/**
 * Telling a review ticket from an implementation ticket on a fresh process,
 * where `createReviewTicket`'s own answer is long gone: the only thing that
 * survives is what got written to GitHub, so this is read back from the body
 * rather than asserted against anything the adapter remembers.
 */
describe("ghIssueTracker.listEligibleTickets — review tickets", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/12",
  );

  it("carries the pull request a review ticket's body names", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 42,
          title: "Review the draft pull request for #7",
          body: `Review ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]?.pullRequest, PULL_REQUEST);
  });

  it("leaves an implementation ticket's pull request unset", async (t) => {
    await recordingGh(
      t,
      issues([{ number: 7, title: "Add the thing", body: "Do the thing." }]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]?.pullRequest, undefined);
  });

  it("does not mistake an unrelated body for a review's", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 9,
          title: "Review the draft pull request for #7",
          body: `See also ${PULL_REQUEST}.`,
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.pullRequest, undefined);
  });

  /**
   * `linkToParent`'s fallback, for a tracker without sub-issues, prepends
   * `Part of #N.` ahead of the review sentence — so the sentence is no
   * longer the whole body, and a match anchored to the body's start would
   * miss it every morning after the one that created it.
   */
  it("still carries the pull request when the body also names its parent", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 42,
          title: "Review the draft pull request for #7",
          body: `Part of #7.\n\nReview ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.pullRequest, PULL_REQUEST);
  });

  it("asks for the body, since it is the only place the association survives", async (t) => {
    const gh = await recordingGh(t, issues([]));

    await ghIssueTracker().listEligibleTickets(PILOT);

    const list = callWith(await gh.calls(), "issue", "list");
    assert.ok(list);
    assert.equal(
      valueOf(list, "--json"),
      "number,title,body,subIssuesSummary,blockedBy,labels",
    );
  });
});

/**
 * A ticket's model label, read from the labels the same listing carries.
 * What a label says is `modelLabelOf`'s to decide; these check that the
 * adapter hands it every label a ticket has, and only that ticket's.
 */
describe("ghIssueTracker.listEligibleTickets — model labels", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  function issue(
    number: number,
    labels: string[],
    body = "",
  ): Record<string, unknown> {
    return rawIssue({
      number,
      title: `Ticket ${number}`,
      body,
      labels: labels.map((name) => ({ id: `LA_${name}`, name, color: "ededed" })),
    });
  }

  it("names no model for a ticket without a model label", async (t) => {
    await recordingGh(t, issues([issue(7, [READY_FOR_AGENT_LABEL, "enhancement"])]));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.modelLabel, undefined);
  });

  it("names the model a ticket labelled model:opus asks for", async (t) => {
    await recordingGh(t, issues([issue(7, [READY_FOR_AGENT_LABEL, "model:opus"])]));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.deepEqual(tickets[0]?.modelLabel, {
      kind: "named",
      name: modelName("opus"),
    });
  });

  it("passes a name no Claude model uses through unchanged", async (t) => {
    await recordingGh(t, issues([issue(7, ["model:GPT-9-Turbo"])]));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.deepEqual(tickets[0]?.modelLabel, {
      kind: "named",
      name: modelName("GPT-9-Turbo"),
    });
  });

  it("marks a ticket with two model labels as conflicting, with both names", async (t) => {
    await recordingGh(t, issues([issue(7, ["model:opus", "model:haiku"])]));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets.length, 1, "a conflicting ticket is still returned");
    assert.deepEqual(tickets[0]?.modelLabel, {
      kind: "conflicting",
      names: [modelName("opus"), modelName("haiku")],
    });
  });

  it("marks a ticket whose model label names no usable model as unusable", async (t) => {
    await recordingGh(t, issues([issue(7, ["model:claude opus"])]));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets.length, 1, "an unusable ticket is still returned");
    assert.deepEqual(tickets[0]?.modelLabel, {
      kind: "unusable",
      labels: ["model:claude opus"],
    });
  });

  it("reads a review ticket's own labels, not its parent's", async (t) => {
    const pullRequest = "https://github.com/nadav-alon/pilot/pull/12";
    await recordingGh(
      t,
      issues([
        issue(7, ["model:opus"]),
        issue(
          42,
          [READY_FOR_AGENT_LABEL],
          `Review ${pullRequest}, the draft pull request opened for #7.`,
        ),
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    const review = tickets.find((ticket) => ticket.number === 42);
    assert.equal(review?.pullRequest, pullRequest);
    assert.equal(review?.modelLabel, undefined);
  });

  it("reads the labels afresh on every call", async (t) => {
    const listing = path.join(await tempHome("gh-listing"), "issues.json");
    await recordingGh(t, `cat ${listing}`);
    const tracker = ghIssueTracker();

    await writeFile(listing, JSON.stringify([issue(7, ["model:opus"])]));
    const { tickets: before } = await tracker.listEligibleTickets(PILOT);
    await writeFile(listing, JSON.stringify([issue(7, ["model:sonnet"])]));
    const { tickets: after } = await tracker.listEligibleTickets(PILOT);

    assert.deepEqual(before[0]?.modelLabel, { kind: "named", name: modelName("opus") });
    assert.deepEqual(after[0]?.modelLabel, { kind: "named", name: modelName("sonnet") });
  });
});

describe("ghIssueTracker.listEligibleTickets — sub-issues", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("carries the count still open, not the total", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 66,
          title: "Too big for one run",
          subIssuesSummary: { total: 7, completed: 3 },
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.openSubIssues, 4);
  });

  it("leaves openSubIssues unset once every sub-issue has closed", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 66,
          title: "Too big for one run",
          subIssuesSummary: { total: 7, completed: 7 },
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.openSubIssues, undefined);
  });

  it("leaves openSubIssues unset for a ticket with no sub-issues at all", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 7,
          title: "Add the thing",
          subIssuesSummary: { total: 0, completed: 0 },
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.openSubIssues, undefined);
  });
});

describe("ghIssueTracker.listEligibleTickets — blockers", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("carries how many of a ticket's blockers are still open, not how many it has", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 56,
          title: "Waits on others",
          blockedBy: {
            nodes: [
              { number: 55, state: "OPEN" },
              { number: 54, state: "OPEN" },
              { number: 53, state: "CLOSED" },
            ],
            totalCount: 3,
          },
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.openBlockers, 2);
  });

  it("leaves openBlockers unset once every blocker has closed", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 54,
          title: "Was waiting",
          blockedBy: {
            nodes: [{ number: 47, state: "CLOSED" }],
            totalCount: 1,
          },
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.openBlockers, undefined);
  });

  it("leaves openBlockers unset for a ticket nothing blocks", async (t) => {
    await recordingGh(
      t,
      issues([
        {
          number: 7,
          title: "Add the thing",
          blockedBy: { nodes: [], totalCount: 0 },
        },
      ]),
    );

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.openBlockers, undefined);
  });
});

describe("ghIssueTracker.listEligibleTickets — ticket priority", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  function labelled(...names: string[]): string {
    const issue = {
      number: 7,
      title: "Add the thing",
      body: "",
      subIssuesSummary: { total: 0, completed: 0 },
      blockedBy: { nodes: [], totalCount: 0 },
      labels: names.map((name) => ({ name })),
    };
    return `printf '%s' '${JSON.stringify([issue])}'`;
  }

  it("carries the level a priority label names", async (t) => {
    await recordingGh(t, labelled(READY_FOR_AGENT_LABEL, "priority:2"));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.priority, 2);
  });

  it("counts a ticket carrying several levels as its smallest", async (t) => {
    await recordingGh(t, labelled("priority:3", "priority:1"));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.priority, 1);
  });

  for (const label of ["priority:7", "priority:high", "priority:"]) {
    it(`ignores ${label}, which names none of the three levels`, async (t) => {
      await recordingGh(t, labelled(label));

      const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

      assert.equal(tickets[0]?.priority, undefined);
    });
  }

  it("leaves priority unset for a ticket carrying no priority label", async (t) => {
    await recordingGh(t, labelled(READY_FOR_AGENT_LABEL, "enhancement"));

    const { tickets } = await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(tickets[0]?.priority, undefined);
  });
});

describe("ghIssueTracker.listEligibleTickets — truncated backlog", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  /** `count` eligible issues, newest first, the order `gh issue list` answers in. */
  function newestFirst(count: number): string {
    const all = Array.from({ length: count }, (_, index) => ({
      number: count - index,
      title: `Ticket ${count - index}`,
      body: "",
      subIssuesSummary: { total: 0, completed: 0 },
      blockedBy: { nodes: [], totalCount: 0 },
      labels: [],
    }));
    return `printf '%s' '${JSON.stringify(all)}'`;
  }

  it("asks for one more issue than it reads, so it can tell a full backlog from a longer one", async (t) => {
    const gh = await recordingGh(t, newestFirst(0));

    await ghIssueTracker().listEligibleTickets(PILOT);

    const list = callWith(await gh.calls(), "issue", "list");
    assert.ok(list);
    assert.equal(valueOf(list, "--limit"), "101");
  });

  it("reads the newest 100 of a longer backlog and says it was truncated", async (t) => {
    await recordingGh(t, newestFirst(101));

    const { tickets, truncated } =
      await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(truncated, true);
    assert.equal(tickets.length, 100);
    assert.equal(tickets[0]?.number, 101);
    assert.ok(!tickets.some((ticket) => ticket.number === 1));
  });

  it("reads all of a backlog of 100 and says it was not truncated", async (t) => {
    await recordingGh(t, newestFirst(100));

    const { tickets, truncated } =
      await ghIssueTracker().listEligibleTickets(PILOT);

    assert.equal(truncated, false);
    assert.equal(tickets.length, 100);
    assert.ok(tickets.some((ticket) => ticket.number === 1));
  });
});

describe("ghIssueTracker.closeReviewTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const REVIEW: ReviewTicket = {
    repo: PILOT,
    number: 42,
    title: "Review the draft pull request for #7",
    pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
  };

  it("closes the review ticket in its own repo", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().closeReviewTicket(REVIEW);

    const close = callWith(await gh.calls(), "issue", "close");
    assert.ok(close, "the review should be closed with `gh issue close`");
    assert.equal(valueOf(close, "--repo"), PILOT);
    assert.ok(close.includes("42"));
  });
});

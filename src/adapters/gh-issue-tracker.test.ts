import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { ghIssueTracker } from "./gh-issue-tracker.ts";
import {
  ENHANCEMENT_LABEL,
  NEEDS_TRIAGE_LABEL,
  READY_DISCOVERY_LABEL,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  SIZE_S_LABEL,
  TURBOABLE_LABEL,
  isSpecReviewTicket,
  isSupertask,
  issueNumber,
  modelName,
  pullRequestUrl,
  repoSlug,
  type ApplyReviewTicket,
  type RebaseTicket,
  type ReviewTicket,
  type RunSpan,
  type Ticket,
} from "../ports/index.ts";
import { callWith, recordingGh, tempHome, valueOf } from "../testing/index.ts";

// A public repo the developer doesn't own, guaranteed to carry no
// ready-for-agent issues. Verifies an empty backlog is not an error. Also
// referenced from `morning-run.test.ts`, for the same reason. Read live: it
// is static and outside the developer's own control, so it cannot drift the
// way an actively worked repo does.
const EMPTY = repoSlug("octocat/Hello-World");

describe("ghIssueTracker.listOpenIssues — live smoke test", () => {
  it("finds nothing eligible in a project with no ready-for-agent issues, without an error", async () => {
    const { issues } = await ghIssueTracker().listOpenIssues(EMPTY);

    assert.deepEqual(
      issues.filter((issue) => issue.eligible),
      [],
    );
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
const SUMMARY_URL =
  "https://github.com/nadav-alon/side-projects-manager/issues/1";

describe("ghIssueTracker.publishSummary", () => {
  it("creates one issue, naming no repo of its own, and answers with its address", async (t) => {
    const gh = await recordingGh(t, `echo ${SUMMARY_URL}`);

    const url = await ghIssueTracker().publishSummary(
      "Morning loop summary — 2026-01-01",
      "Nothing to do.",
    );

    assert.equal(url, SUMMARY_URL);
    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create, "the summary should be created with `gh issue create`");
    assert.equal(valueOf(create, "--title"), "Morning loop summary — 2026-01-01");
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
    await recordingGh(t, `pwd -P > ${recorded}\necho ${SUMMARY_URL}`);

    await ghIssueTracker(home).publishSummary(
      "Morning loop summary — 2026-01-01",
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

  it("fails naming what gh answered, when it is not an issue URL", async (t) => {
    await recordingGh(t, "echo not-a-url");

    await assert.rejects(
      ghIssueTracker().publishSummary(
        "Morning loop summary — 2026-01-01",
        "Nothing to do.",
      ),
      /expected the new issue's URL, got: not-a-url/,
    );
  });

  it("reads the URL off stdout even when gh prints something ahead of it", async (t) => {
    await recordingGh(
      t,
      `echo "Creating issue in nadav-alon/side-projects-manager"\necho ${SUMMARY_URL}`,
    );

    const url = await ghIssueTracker().publishSummary(
      "Morning loop summary — 2026-01-01",
      "Nothing to do.",
    );

    // A banner ahead of the URL must not turn an issue that was created into
    // one this reports as failed to publish.
    assert.equal(url, SUMMARY_URL);
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
    number: issueNumber(7),
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

  it("never opens the review carrying turboable", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.ok(!create.includes(TURBOABLE_LABEL));
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
    await recordingGh(t, WORKING);

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

  it("rejects a new issue's URL naming a number that is not a positive integer, loudly", async (t) => {
    await recordingGh(
      t,
      `echo https://github.com/nadav-alon/pilot/issues/0`,
    );

    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      /named a number that is not a positive integer/,
    );
  });

  it("says so when linking fails after the review was opened", async (t) => {
    await recordingGh(
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
    number: issueNumber(7),
    title: "Add the thing",
  };

  const COMMENT = "The morning loop ran this ticket and the agent gave up.\n\nWhy it stopped: red tests";

  /** A tracker where every call succeeds, on a ticket that is open. */
  const WORKING = [
    `case "$1 $2" in`,
    `  "issue view") echo "OPEN" ;;`,
    `  *) : ;;`,
    `esac`,
  ].join("\n");

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
        `  "issue view") echo "OPEN" ;;`,
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
        `  "issue view "*) echo "OPEN" ;;`,
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
        `  "issue view "*) echo "OPEN" ;;`,
        `  *--remove-label*) echo "HTTP 403" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    // Still eligible, so still due to come round: the one outcome the caller
    // has to hear about, because the developer has to relabel it by hand.
    await assert.rejects(ghIssueTracker().handBack(TICKET, COMMENT));
  });

  it("leaves a closed ticket alone: no comment, no label touched", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue view") echo "CLOSED" ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const outcome = await ghIssueTracker().handBack(TICKET, COMMENT);

    assert.equal(outcome, "already-closed");
    const calls = await gh.calls();
    assert.equal(callWith(calls, "issue", "comment"), undefined);
    assert.equal(callWith(calls, "--remove-label"), undefined);
    assert.equal(callWith(calls, "--add-label"), undefined);
  });

  it("hands an open ticket back even when the state read itself fails", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue view") echo "rate limited" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    // The read failed, not the ticket's own state: proceeding as open keeps
    // this check from adding a new way to refuse an open ticket's hand-back.
    const outcome = await ghIssueTracker().handBack(TICKET, COMMENT);

    assert.equal(outcome, "handed-back");
    const calls = await gh.calls();
    assert.ok(callWith(calls, "issue", "comment"));
    assert.ok(callWith(calls, "--remove-label"));
  });

  it("fails the hand-back when the state read answers with neither OPEN nor CLOSED", async (t) => {
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue view") echo "MERGED" ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    await assert.rejects(
      ghIssueTracker().handBack(TICKET, COMMENT),
      /neither OPEN nor CLOSED/,
    );
  });
});

describe("ghIssueTracker.comment", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  const TICKET: Ticket = {
    repo: PILOT,
    number: issueNumber(7),
    title: "Add the thing",
  };

  it("posts the given text on the ticket, in its own repo", async (t) => {
    const gh = await recordingGh(t, "");

    await ghIssueTracker().comment(TICKET, "Found something while working this.");

    const comment = callWith(await gh.calls(), "issue", "comment");
    assert.ok(comment, "the ticket should be commented on");
    assert.ok(comment.includes("7"));
    assert.equal(valueOf(comment, "--repo"), PILOT);
    assert.equal(
      valueOf(comment, "--body"),
      "Found something while working this.",
    );
  });

  it("touches no label", async (t) => {
    const gh = await recordingGh(t, "");

    await ghIssueTracker().comment(TICKET, "Found something while working this.");

    const calls = await gh.calls();
    assert.equal(callWith(calls, "--add-label"), undefined);
    assert.equal(callWith(calls, "--remove-label"), undefined);
    assert.equal(callWith(calls, "issue", "edit"), undefined);
    assert.equal(callWith(calls, "issue", "close"), undefined);
  });
});

describe("ghIssueTracker.createDiscoveredTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  const TICKET: Ticket = {
    repo: PILOT,
    number: issueNumber(7),
    title: "Add the thing",
  };

  const DISCOVERED_URL = "https://github.com/nadav-alon/pilot/issues/43";
  /** The discovered ticket's database id, which is what the edge takes. */
  const DISCOVERED_ID = "2159872999";

  const DISCOVERY = {
    title: "The retry loop never backs off",
    body: "Hammers the API on every failure.",
  };

  /** A tracker where creating, reading back and blocking all succeed. */
  const WORKING = [
    `case "$1 $2" in`,
    `  "issue create") echo ${DISCOVERED_URL} ;;`,
    `  "api repos/nadav-alon/pilot/issues/43") echo ${DISCOVERED_ID} ;;`,
    `  *) : ;;`,
    `esac`,
  ].join("\n");

  it("creates it in the ticket's own repo, carrying needs-triage and enhancement, never ready-for-agent", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createDiscoveredTicket(TICKET, DISCOVERY);

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create, "the ticket should be created with `gh issue create`");
    assert.equal(valueOf(create, "--repo"), PILOT);
    assert.ok(create.includes(NEEDS_TRIAGE_LABEL));
    assert.ok(create.includes(ENHANCEMENT_LABEL));
    assert.ok(!create.includes(READY_FOR_AGENT_LABEL));
  });

  it("creates a ready discovery's ticket carrying ready-for-agent, size:S and enhancement, never needs-triage", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createDiscoveredTicket(TICKET, {
      ...DISCOVERY,
      ready: true,
    });

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create, "the ticket should be created with `gh issue create`");
    assert.ok(create.includes(READY_FOR_AGENT_LABEL));
    assert.ok(create.includes(SIZE_S_LABEL));
    assert.ok(create.includes(ENHANCEMENT_LABEL));
    assert.ok(!create.includes(NEEDS_TRIAGE_LABEL));
  });

  it("never opens a discovered ticket carrying turboable, ready or not", async (t) => {
    const notReady = await recordingGh(t, WORKING);
    await ghIssueTracker().createDiscoveredTicket(TICKET, DISCOVERY);
    const notReadyCreate = callWith(await notReady.calls(), "issue", "create");
    assert.ok(notReadyCreate);
    assert.ok(!notReadyCreate.includes(TURBOABLE_LABEL));

    const ready = await recordingGh(t, WORKING);
    await ghIssueTracker().createDiscoveredTicket(TICKET, { ...DISCOVERY, ready: true });
    const readyCreate = callWith(await ready.calls(), "issue", "create");
    assert.ok(readyCreate);
    assert.ok(!readyCreate.includes(TURBOABLE_LABEL));
  });

  it("marks a ready discovery's ticket with the ready discovery label, for the chain guard", async (t) => {
    const gh = await recordingGh(t, WORKING);

    const discovered = await ghIssueTracker().createDiscoveredTicket(TICKET, {
      ...DISCOVERY,
      ready: true,
    });

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.ok(create.includes(READY_DISCOVERY_LABEL));
    assert.equal(discovered.readyDiscovery, true);
  });

  it("creates both labels first, since a project may have neither", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createDiscoveredTicket(TICKET, DISCOVERY);

    const calls = await gh.calls();
    const needsTriage = callWith(calls, "label", "create", NEEDS_TRIAGE_LABEL);
    const enhancement = callWith(calls, "label", "create", ENHANCEMENT_LABEL);
    const create = callWith(calls, "issue", "create");
    assert.ok(needsTriage, "needs-triage should be created");
    assert.ok(enhancement, "enhancement should be created");
    assert.ok(create);
    assert.ok(calls.indexOf(needsTriage) < calls.indexOf(create));
    assert.ok(calls.indexOf(enhancement) < calls.indexOf(create));
  });

  it("opens the ticket even where both labels already exist", async (t) => {
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "label create") echo "label already exists" >&2; exit 1 ;;`,
        `  "issue create") echo ${DISCOVERED_URL} ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const discovered = await ghIssueTracker().createDiscoveredTicket(
      TICKET,
      DISCOVERY,
    );

    assert.equal(discovered.number, 43);
  });

  it("names the given body and the ticket it was discovered while working", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createDiscoveredTicket(TICKET, DISCOVERY);

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.equal(valueOf(create, "--title"), DISCOVERY.title);
    const body = valueOf(create, "--body") ?? "";
    assert.match(body, /Hammers the API on every failure\./);
    assert.match(body, /Discovered while working #7\./);
  });

  it("answers with the new ticket", async (t) => {
    await recordingGh(t, WORKING);

    const discovered = await ghIssueTracker().createDiscoveredTicket(
      TICKET,
      DISCOVERY,
    );

    assert.equal(discovered.repo, PILOT);
    assert.equal(discovered.number, 43);
    assert.equal(discovered.title, DISCOVERY.title);
  });

  it("adds no edge when blocking is not asked for", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createDiscoveredTicket(TICKET, DISCOVERY);

    assert.equal(
      callWith(
        await gh.calls(),
        "repos/nadav-alon/pilot/issues/7/dependencies/blocked_by",
      ),
      undefined,
    );
  });

  it("blocks the ticket, keyed on the new issue's database id, when asked", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createDiscoveredTicket(TICKET, {
      ...DISCOVERY,
      blocking: true,
    });

    const edge = callWith(await gh.calls(), "api", "--method", "POST");
    assert.ok(edge, "a blocked_by edge should be added");
    assert.ok(
      edge.includes("repos/nadav-alon/pilot/issues/7/dependencies/blocked_by"),
    );
    // The discovered issue's database id, never its `#number` or node id.
    assert.equal(valueOf(edge, "-F"), `issue_id=${DISCOVERED_ID}`);
  });

  it("reports a refused edge without losing the created issue", async (t) => {
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${DISCOVERED_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/43") echo ${DISCOVERED_ID} ;;`,
        `  "api --method") echo "gh: Forbidden (HTTP 403)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    // The discovery is not lost — it exists and is triageable — but the
    // rejection is where the developer learns it, since nothing else names
    // both the created issue and the refused edge.
    await assert.rejects(
      ghIssueTracker().createDiscoveredTicket(TICKET, {
        ...DISCOVERY,
        blocking: true,
      }),
      /Opened #43 in nadav-alon\/pilot .* could not block #7/s,
    );
  });
});

/**
 * One issue as `gh issue list` answers for it: every field the adapter asks
 * for, filled in as a ticket with none of it — no body, sub-issues, blockers
 * or labels — unless `fields` names its own. Each listing test sets only the
 * fields it is about.
 *
 * The shape (`blockedBy: { nodes, totalCount }`, `parent` and each
 * `blockedBy.nodes` entry as `{ id, number, state, title, url }`, each label
 * as `{ id, name, description, color }`) was captured once against a real
 * repo, not hand-invented: `gh --version` 2.101.0, running
 * `gh issue list --repo nadav-alon/side-projects-manager --state open
 * --limit 2 --json number,title,body,blockedBy,parent,labels`.
 */
function rawIssue(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    body: "",
    blockedBy: { nodes: [], totalCount: 0 },
    parent: null,
    labels: [],
    ...fields,
  };
}

// `printf '%s'` rather than `echo`: `/bin/sh`'s builtin `echo` interprets
// `\n` in its argument on some shells (dash's is XSI-conformant), turning
// the `\n` a body with a blank line in it serializes to back into a raw
// newline and breaking the JSON `gh` is meant to answer with.
function listing(rawIssues: Record<string, unknown>[]): string {
  return `printf '%s' '${JSON.stringify(rawIssues.map(rawIssue))}'`;
}

/** A blocker or parent as `blockedBy.nodes` and `parent` report one. */
function linkedIssue(
  repo: string,
  number: number,
  state: "OPEN" | "CLOSED" = "OPEN",
): Record<string, unknown> {
  return {
    id: `I_${repo}_${number}`,
    number,
    state,
    title: `Issue ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
  };
}

/** A raw issue carrying `labels` by name, the way label-reading tests need. */
function issue(
  number: number,
  labels: string[],
  body = "",
): Record<string, unknown> {
  return rawIssue({
    number,
    title: `Ticket ${number}`,
    body,
    labels: labels.map((name) => ({
      id: `LA_${name}`,
      name,
      description: "",
      color: "ededed",
    })),
  });
}

describe("ghIssueTracker.listOpenIssues — every open issue", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("asks for every open issue, whatever its labels, with its parent", async (t) => {
    const gh = await recordingGh(t, listing([]));

    await ghIssueTracker().listOpenIssues(PILOT);

    const list = callWith(await gh.calls(), "issue", "list");
    assert.ok(list);
    // State filtering itself now lives in `gh`, not the adapter, so a stub
    // fixture can't prove closed issues are excluded — only that `--state
    // open` is the filter asked for.
    assert.equal(valueOf(list, "--state"), "open");
    assert.equal(valueOf(list, "--label"), undefined);
    assert.ok(valueOf(list, "--json")?.split(",").includes("parent"));
  });

  it("returns an open issue without ready-for-agent, with its priority label", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 205,
          title: "Spec: the thing",
          labels: [{ name: READY_FOR_HUMAN_LABEL }, { name: "priority:1" }],
        },
      ]),
    );

    const { issues: listed } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.ticket.number, 205);
    assert.equal(listed[0]?.eligible, false);
    assert.equal(listed[0]?.ticket.priority, 1);
  });

  it("marks an issue carrying ready-for-agent as eligible", async (t) => {
    await recordingGh(
      t,
      listing([
        { number: 7, title: "Add the thing", labels: [{ name: READY_FOR_AGENT_LABEL }] },
      ]),
    );

    const { issues: listed } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(listed[0]?.eligible, true);
    assert.equal(listed[0]?.ticket.title, "Add the thing");
    assert.equal(listed[0]?.ticket.repo, PILOT);
  });

  it("rejects an issue number that is not a positive integer, loudly", async (t) => {
    await recordingGh(t, listing([{ number: 0, title: "Add the thing" }]));

    await assert.rejects(ghIssueTracker().listOpenIssues(PILOT), {
      message: /"number" must be a positive integer, got 0/,
    });
  });
});

describe("ghIssueTracker.listOpenIssues — parent", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("reports a sub-issue's parent number where the parent is in the same repo", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 208,
          title: "Part of the spec",
          parent: linkedIssue("nadav-alon/pilot", 205),
        },
      ]),
    );

    const { issues: listed } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(listed[0]?.parent, 205);
  });

  it("reports no parent where the parent is in another repo", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 208,
          title: "Part of a spec elsewhere",
          parent: linkedIssue("nadav-alon/elsewhere", 205),
        },
      ]),
    );

    const { issues: listed } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(listed[0]?.parent, undefined);
  });

  it("reports no parent for an issue that is no one's sub-issue", async (t) => {
    await recordingGh(t, listing([{ number: 7, title: "Add the thing" }]));

    const { issues: listed } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(listed[0]?.parent, undefined);
  });

  it("rejects a parent number that is not a positive integer, loudly", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 208,
          title: "Part of the spec",
          parent: linkedIssue("nadav-alon/pilot", 0),
        },
      ]),
    );

    await assert.rejects(ghIssueTracker().listOpenIssues(PILOT), {
      message: /"parent.number" must be a positive integer, got 0/,
    });
  });
});

/**
 * Telling a review ticket from an implementation ticket on a fresh process,
 * where `createReviewTicket`'s own answer is long gone: the only thing that
 * survives is what got written to GitHub, so this is read back from the body
 * rather than asserted against anything the adapter remembers.
 */
describe("ghIssueTracker.listOpenIssues — review tickets", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/12",
  );

  it("carries the pull request a review ticket's body names", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 42,
          title: "Review the draft pull request for #7",
          body: `Review ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "review",
      url: PULL_REQUEST,
    });
  });

  it("leaves an implementation ticket's pull request unset", async (t) => {
    await recordingGh(
      t,
      listing([{ number: 7, title: "Add the thing", body: "Do the thing." }]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.ticket.pullRequest, undefined);
  });

  it("does not mistake an unrelated body for a review's", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 9,
          title: "Review the draft pull request for #7",
          body: `See also ${PULL_REQUEST}.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.pullRequest, undefined);
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
      listing([
        {
          number: 42,
          title: "Review the draft pull request for #7",
          body: `Part of #7.\n\nReview ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "review",
      url: PULL_REQUEST,
    });
  });

  it("asks for the body, since it is the only place the association survives", async (t) => {
    const gh = await recordingGh(t, listing([]));

    await ghIssueTracker().listOpenIssues(PILOT);

    const list = callWith(await gh.calls(), "issue", "list");
    assert.ok(list);
    assert.equal(
      valueOf(list, "--json"),
      "number,title,body,blockedBy,parent,labels",
    );
  });
});

/**
 * Telling an apply-review ticket from a review and from an implementation
 * ticket, the same way `REVIEW_BODY` is told apart: the apply-review line is
 * written by the apply-review workflow, never by this adapter, so it is read
 * back from the body exactly as a review's association is.
 */
describe("ghIssueTracker.listOpenIssues — apply-review tickets", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/12",
  );

  it("carries the pull request an apply-review ticket's body names", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 42,
          title: "Apply the review",
          body: `Apply the review on ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "apply-review",
      url: PULL_REQUEST,
    });
  });

  it("never mistakes a review body and an apply-review body for each other", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 8,
          title: "Review the draft pull request for #7",
          body: `Review ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
        {
          number: 9,
          title: "Apply the review",
          body: `Apply the review on ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(
      issues.map(({ ticket }) => ticket.pullRequest?.kind),
      ["review", "apply-review"],
    );
  });

  it("reads a body carrying both lines as a review", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 9,
          title: "Apply the review",
          body: `Apply the review on ${PULL_REQUEST}, the draft pull request opened for #7.\n\nReview ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.pullRequest?.kind, "review");
  });

  it("reads past a malformed review line to a well-formed apply-review line", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 9,
          title: "Apply the review",
          body: `Review not-a-url, the draft pull request opened for #7.\n\nApply the review on ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "apply-review",
      url: PULL_REQUEST,
    });
  });

  it("treats a malformed apply-review line as an implementation ticket", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 9,
          title: "Apply the review",
          body: "Apply the review on not-a-url, the draft pull request opened for #7.",
        },
        {
          number: 10,
          title: "Apply the review",
          body: `Apply the review on ${PULL_REQUEST}, the draft pull request opened for it.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 2);
    assert.equal(issues[0]?.ticket.pullRequest, undefined);
    assert.equal(issues[1]?.ticket.pullRequest, undefined);
  });

  /**
   * `linkToParent`'s fallback, for a tracker without sub-issues, prepends
   * `Part of #N.` ahead of the review sentence — the apply-review workflow's
   * own body writes the same shape, so the association survives it too.
   */
  it("still carries the pull request when the body also names its parent", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 42,
          title: "Apply the review",
          body: `Part of #7.\n\nApply the review on ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "apply-review",
      url: PULL_REQUEST,
    });
  });
});

/**
 * Telling a rebase ticket from a review, an apply-review and an
 * implementation ticket, the same way `APPLY_REVIEW_BODY` is told apart: the
 * rebase line is written by the `/rebase` workflow, never by this adapter, so
 * it is read back from the body exactly as a review's or an apply-review's
 * association is.
 */
describe("ghIssueTracker.listOpenIssues — rebase tickets", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/12",
  );

  it("carries the pull request a rebase ticket's body names", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 42,
          title: "Rebase #7",
          body: `Rebase ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "rebase",
      url: PULL_REQUEST,
    });
  });

  it("never mistakes a rebase body and an apply-review body for each other", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 9,
          title: "Apply the review",
          body: `Apply the review on ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
        {
          number: 10,
          title: "Rebase #7",
          body: `Rebase ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(
      issues.map(({ ticket }) => ticket.pullRequest?.kind),
      ["apply-review", "rebase"],
    );
  });

  it("reads past a malformed apply-review line to a well-formed rebase line", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 9,
          title: "Rebase #7",
          body: `Apply the review on not-a-url, the draft pull request opened for #7.\n\nRebase ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "rebase",
      url: PULL_REQUEST,
    });
  });

  it("treats a malformed rebase line as an implementation ticket", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 9,
          title: "Rebase #7",
          body: "Rebase not-a-url, the draft pull request opened for #7.",
        },
        {
          number: 10,
          title: "Rebase #7",
          body: `Rebase ${PULL_REQUEST}, the draft pull request opened for it.`,
        },
        {
          number: 11,
          title: "Rebase #7",
          body: `Rebasing ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 3);
    assert.equal(issues[0]?.ticket.pullRequest, undefined);
    assert.equal(issues[1]?.ticket.pullRequest, undefined);
    assert.equal(issues[2]?.ticket.pullRequest, undefined);
  });

  /**
   * `linkToParent`'s fallback, for a tracker without sub-issues, prepends
   * `Part of #N.` ahead of the review sentence — a rebase ticket's own body
   * would carry the same shape, so the association survives it too.
   */
  it("still carries the pull request when the body also names its parent", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 42,
          title: "Rebase #7",
          body: `Part of #7.\n\nRebase ${PULL_REQUEST}, the draft pull request opened for #7.`,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.pullRequest, {
      kind: "rebase",
      url: PULL_REQUEST,
    });
  });
});

/**
 * A ticket's model label, read from the labels the same listing carries.
 * What a label says is `modelLabelOf`'s to decide; these check that the
 * adapter hands it every label a ticket has, and only that ticket's.
 */
describe("ghIssueTracker.listOpenIssues — model labels", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("names no model for a ticket without a model label", async (t) => {
    await recordingGh(t, listing([issue(7, [READY_FOR_AGENT_LABEL, "enhancement"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.modelLabel, undefined);
  });

  it("names the model a ticket labelled model:opus asks for", async (t) => {
    await recordingGh(t, listing([issue(7, [READY_FOR_AGENT_LABEL, "model:opus"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.modelLabel, {
      kind: "named",
      name: modelName("opus"),
    });
  });

  it("passes a name no Claude model uses through unchanged", async (t) => {
    await recordingGh(t, listing([issue(7, ["model:GPT-9-Turbo"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.modelLabel, {
      kind: "named",
      name: modelName("GPT-9-Turbo"),
    });
  });

  it("marks a ticket with two model labels as conflicting, with both names", async (t) => {
    await recordingGh(t, listing([issue(7, ["model:opus", "model:haiku"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 1, "a conflicting ticket is still returned");
    assert.deepEqual(issues[0]?.ticket.modelLabel, {
      kind: "conflicting",
      names: [modelName("opus"), modelName("haiku")],
      labels: ["model:opus", "model:haiku"],
    });
  });

  it("marks a ticket whose model label names no usable model as unusable", async (t) => {
    await recordingGh(t, listing([issue(7, ["model:claude opus"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues.length, 1, "an unusable ticket is still returned");
    assert.deepEqual(issues[0]?.ticket.modelLabel, {
      kind: "unusable",
      labels: ["model:claude opus"],
    });
  });

  it("reads a review ticket's own labels, not its parent's", async (t) => {
    const pullRequest = "https://github.com/nadav-alon/pilot/pull/12";
    await recordingGh(
      t,
      listing([
        issue(7, ["model:opus"]),
        issue(
          42,
          [READY_FOR_AGENT_LABEL],
          `Review ${pullRequest}, the draft pull request opened for #7.`,
        ),
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    const review = issues.find((issue) => issue.ticket.number === 42)?.ticket;
    assert.deepEqual(review?.pullRequest, { kind: "review", url: pullRequest });
    assert.equal(review?.modelLabel, undefined);
  });

  it("reads the labels afresh on every call", async (t) => {
    const listing = path.join(await tempHome("gh-listing"), "issues.json");
    await recordingGh(t, `cat ${listing}`);
    const tracker = ghIssueTracker();

    await writeFile(listing, JSON.stringify([issue(7, ["model:opus"])]));
    const { issues: before } = await tracker.listOpenIssues(PILOT);
    await writeFile(listing, JSON.stringify([issue(7, ["model:sonnet"])]));
    const { issues: after } = await tracker.listOpenIssues(PILOT);

    assert.deepEqual(before[0]?.ticket.modelLabel, { kind: "named", name: modelName("opus") });
    assert.deepEqual(after[0]?.ticket.modelLabel, { kind: "named", name: modelName("sonnet") });
  });
});

/**
 * A ticket's size label, read from the labels the same listing carries.
 * What a label says is `sizeLabelOf`'s to decide; these check that the
 * adapter hands it every label a ticket has.
 */
describe("ghIssueTracker.listOpenIssues — size labels", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("declares no size for a ticket without a size label", async (t) => {
    await recordingGh(t, listing([issue(7, [READY_FOR_AGENT_LABEL, "enhancement"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.sizeLabel, undefined);
  });

  it("declares the size a ticket labelled size:M asks for", async (t) => {
    await recordingGh(t, listing([issue(7, [READY_FOR_AGENT_LABEL, "size:M"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.sizeLabel, { kind: "declared", size: "M" });
  });

  it("marks a ticket whose size label names no recognised size as unusable", async (t) => {
    await recordingGh(t, listing([issue(7, ["size:huge"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.ticket.sizeLabel, {
      kind: "unusable",
      labels: ["size:huge"],
    });
  });
});

/**
 * Whether a ticket is a supertask, per `isSupertask`: declared by the
 * supertask label, read from the same listing as every other label, never
 * inferred from a sub-issue count.
 */
describe("ghIssueTracker.listOpenIssues — supertask label", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("reads a ticket carrying the supertask label as a supertask", async (t) => {
    await recordingGh(t, listing([issue(7, ["supertask"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(isSupertask(issues[0]!.ticket), true);
  });

  it("does not read an ordinary ticket as a supertask", async (t) => {
    await recordingGh(t, listing([issue(7, [READY_FOR_AGENT_LABEL])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(isSupertask(issues[0]!.ticket), false);
  });
});

/**
 * Whether a ticket is a spec review, per `isSpecReviewTicket`: declared by
 * the spec review label, read from the same listing as every other label,
 * and only where the ticket carries no pull request binding.
 */
describe("ghIssueTracker.listOpenIssues — spec review label", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("reads a ticket carrying the spec review label as a spec review", async (t) => {
    await recordingGh(t, listing([issue(7, ["spec-review"])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(isSpecReviewTicket(issues[0]!.ticket), true);
  });

  it("does not read an ordinary ticket as a spec review", async (t) => {
    await recordingGh(t, listing([issue(7, [READY_FOR_AGENT_LABEL])]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(isSpecReviewTicket(issues[0]!.ticket), false);
  });
});

describe("ghIssueTracker.listOpenIssues — blockers", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  it("carries how many of a ticket's blockers are still open, not how many it has", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 56,
          title: "Waits on others",
          blockedBy: {
            nodes: [
              linkedIssue("nadav-alon/pilot", 55),
              linkedIssue("nadav-alon/pilot", 54),
              linkedIssue("nadav-alon/pilot", 53, "CLOSED"),
            ],
            totalCount: 3,
          },
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.openBlockers, 2);
  });

  it("counts an open blocker in another repo as blocking", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 56,
          title: "Waits on another project",
          blockedBy: {
            nodes: [linkedIssue("nadav-alon/elsewhere", 12)],
            totalCount: 1,
          },
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.openBlockers, 1);
  });

  it("reports the numbers of its open blockers in the same repo, not closed or cross-repo ones", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 56,
          title: "Waits on others",
          blockedBy: {
            nodes: [
              linkedIssue("nadav-alon/pilot", 55),
              linkedIssue("nadav-alon/pilot", 53, "CLOSED"),
              linkedIssue("nadav-alon/elsewhere", 54),
              linkedIssue("nadav-alon/pilot", 52),
            ],
            totalCount: 4,
          },
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.openBlockerNumbers, [55, 52]);
  });

  it("reports no blocker numbers for an issue nothing open blocks", async (t) => {
    await recordingGh(t, listing([{ number: 7, title: "Add the thing" }]));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.deepEqual(issues[0]?.openBlockerNumbers, []);
  });

  it("leaves openBlockers unset once every blocker has closed", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 54,
          title: "Was waiting",
          blockedBy: {
            nodes: [linkedIssue("nadav-alon/pilot", 47, "CLOSED")],
            totalCount: 1,
          },
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.openBlockers, undefined);
  });

  it("leaves openBlockers unset for a ticket nothing blocks", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 7,
          title: "Add the thing",
          blockedBy: { nodes: [], totalCount: 0 },
      parent: null,
        },
      ]),
    );

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.openBlockers, undefined);
  });

  it("rejects a blocker number that is not a positive integer, loudly", async (t) => {
    await recordingGh(
      t,
      listing([
        {
          number: 56,
          title: "Waits on others",
          blockedBy: {
            nodes: [linkedIssue("nadav-alon/pilot", 0)],
            totalCount: 1,
          },
        },
      ]),
    );

    await assert.rejects(ghIssueTracker().listOpenIssues(PILOT), {
      message: /"blockedBy.nodes.number" must be a positive integer, got 0/,
    });
  });
});

describe("ghIssueTracker.listOpenIssues — ticket priority", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  function labelled(...names: string[]): string {
    const issue = {
      number: 7,
      title: "Add the thing",
      body: "",
      blockedBy: { nodes: [], totalCount: 0 },
      parent: null,
      labels: names.map((name) => ({ name })),
    };
    return `printf '%s' '${JSON.stringify([issue])}'`;
  }

  it("carries the level a priority label names", async (t) => {
    await recordingGh(t, labelled(READY_FOR_AGENT_LABEL, "priority:2"));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.priority, 2);
  });

  it("reads a priority label whatever its case, as GitHub matches labels", async (t) => {
    await recordingGh(t, labelled("Priority:2"));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.priority, 2);
  });

  it("counts a ticket carrying several levels as its smallest", async (t) => {
    await recordingGh(t, labelled("priority:3", "priority:1"));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.priority, 1);
  });

  for (const label of ["priority:7", "priority:high", "priority:"]) {
    it(`ignores ${label}, which names none of the three levels`, async (t) => {
      await recordingGh(t, labelled(label));

      const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

      assert.equal(issues[0]?.ticket.priority, undefined);
    });
  }

  it("leaves priority unset for a ticket carrying no priority label", async (t) => {
    await recordingGh(t, labelled(READY_FOR_AGENT_LABEL, "enhancement"));

    const { issues } = await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(issues[0]?.ticket.priority, undefined);
  });
});

describe("ghIssueTracker.listOpenIssues — truncated backlog", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  /** `count` eligible issues, newest first, the order `gh issue list` answers in. */
  function newestFirst(count: number): string {
    const all = Array.from({ length: count }, (_, index) => ({
      number: count - index,
      title: `Ticket ${count - index}`,
      body: "",
      blockedBy: { nodes: [], totalCount: 0 },
      parent: null,
      labels: [],
    }));
    return `printf '%s' '${JSON.stringify(all)}'`;
  }

  it("asks for one more issue than it reads, so it can tell a full backlog from a longer one", async (t) => {
    const gh = await recordingGh(t, newestFirst(0));

    await ghIssueTracker().listOpenIssues(PILOT);

    const list = callWith(await gh.calls(), "issue", "list");
    assert.ok(list);
    assert.equal(valueOf(list, "--limit"), "301");
  });

  it("reads the newest 300 of 301 open issues and says it was truncated", async (t) => {
    await recordingGh(t, newestFirst(301));

    const { issues, truncated } =
      await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(truncated, true);
    assert.equal(issues.length, 300);
    assert.equal(issues[0]?.ticket.number, 301);
    assert.ok(!issues.some((issue) => issue.ticket.number === 1));
  });

  it("reads all of 300 open issues and says it was not truncated", async (t) => {
    await recordingGh(t, newestFirst(300));

    const { issues, truncated } =
      await ghIssueTracker().listOpenIssues(PILOT);

    assert.equal(truncated, false);
    assert.equal(issues.length, 300);
    assert.ok(issues.some((issue) => issue.ticket.number === 1));
  });
});

describe("ghIssueTracker.closeReviewTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const REVIEW: ReviewTicket = {
    repo: PILOT,
    number: issueNumber(42),
    title: "Review the draft pull request for #7",
    pullRequest: {
      kind: "review",
      url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    },
  };

  it("closes the review ticket in its own repo", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().closeReviewTicket(REVIEW);

    const close = callWith(await gh.calls(), "issue", "close");
    assert.ok(close, "the review should be closed with `gh issue close`");
    assert.equal(valueOf(close, "--repo"), PILOT);
    assert.ok(close.includes("42"));
  });

  it("takes ready-for-agent off, so a reopened review is not back in the queue", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().closeReviewTicket(REVIEW);

    const calls = await gh.calls();
    const close = callWith(calls, "issue", "close");
    const removed = callWith(calls, "--remove-label");
    assert.ok(removed, "ready-for-agent should be removed");
    assert.equal(valueOf(removed, "--remove-label"), READY_FOR_AGENT_LABEL);
    assert.equal(valueOf(removed, "--repo"), PILOT);
    assert.ok(removed.includes("42"));
    // Closed before unlabelled, so a caller who never learns whether the
    // label removal succeeded still finds a closed review, never an open one.
    assert.ok(close, "the ticket should be closed first");
    assert.ok(calls.indexOf(close) < calls.indexOf(removed));
  });

  it("still closes the review when only the label removal is refused", async (t) => {
    await recordingGh(
      t,
      [
        `case "$*" in`,
        `  *--remove-label*) echo "HTTP 403" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );
    t.mock.method(console, "warn", () => undefined);

    // The review is closed either way — a caller told this failed would
    // report a review that is not closed, sending the developer to close one
    // that already is.
    await ghIssueTracker().closeReviewTicket(REVIEW);
  });

  it("closes with a comment when given one, for a review whose pull request already resolved", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().closeReviewTicket(REVIEW, "already merged");

    const close = callWith(await gh.calls(), "issue", "close");
    assert.ok(close);
    assert.equal(valueOf(close, "--comment"), "already merged");
  });

  it("closes without a --comment flag when given none", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().closeReviewTicket(REVIEW);

    const close = callWith(await gh.calls(), "issue", "close");
    assert.ok(close);
    assert.ok(!close.includes("--comment"));
  });
});

describe("ghIssueTracker.closeApplyReviewTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const APPLY_REVIEW: ApplyReviewTicket = {
    repo: PILOT,
    number: issueNumber(43),
    title: "Apply the review on the draft pull request for #7",
    pullRequest: {
      kind: "apply-review",
      url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    },
  };

  it("closes the apply-review ticket in its own repo, with the comment", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().closeApplyReviewTicket(
      APPLY_REVIEW,
      "Nothing to apply.\n\nThe pull request is ready for review.",
    );

    const close = callWith(await gh.calls(), "issue", "close");
    assert.ok(close, "the ticket should be closed with `gh issue close`");
    assert.equal(valueOf(close, "--repo"), PILOT);
    assert.ok(close.includes("43"));
    assert.equal(
      valueOf(close, "--comment"),
      "Nothing to apply.\n\nThe pull request is ready for review.",
    );
  });
});

describe("ghIssueTracker.closeRebaseTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const REBASE: RebaseTicket = {
    repo: PILOT,
    number: issueNumber(44),
    title: "Rebase the draft pull request for #7",
    pullRequest: {
      kind: "rebase",
      url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    },
  };

  it("closes the rebase ticket in its own repo, with the comment", async (t) => {
    const gh = await recordingGh(t, ": ");

    await ghIssueTracker().closeRebaseTicket(
      REBASE,
      "Already sits on its base branch.",
    );

    const close = callWith(await gh.calls(), "issue", "close");
    assert.ok(close, "the ticket should be closed with `gh issue close`");
    assert.equal(valueOf(close, "--repo"), PILOT);
    assert.ok(close.includes("44"));
    assert.equal(
      valueOf(close, "--comment"),
      "Already sits on its base branch.",
    );
  });
});

describe("ghIssueTracker.createSpecReviewTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  const SUPERTASK: Ticket = {
    repo: PILOT,
    number: issueNumber(40),
    title: "Too big for one run",
  };

  const SPEC_REVIEW_URL = "https://github.com/nadav-alon/pilot/issues/50";
  /** The spec review's database id, which is what the sub-issues endpoint takes. */
  const SPEC_REVIEW_ID = "2159872999";

  /** A tracker where creating, reading back and linking all succeed. */
  const WORKING = [
    `case "$1 $2" in`,
    `  "issue create") echo ${SPEC_REVIEW_URL} ;;`,
    `  "api repos/nadav-alon/pilot/issues/50") echo ${SPEC_REVIEW_ID} ;;`,
    `  *) : ;;`,
    `esac`,
  ].join("\n");

  it("creates it in the supertask's own repo, carrying ready-for-agent, spec-review and size:L", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createSpecReviewTicket(SUPERTASK, "Reviews #40.");

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create, "the spec review should be created with `gh issue create`");
    assert.equal(valueOf(create, "--repo"), PILOT);
    assert.ok(create.includes(READY_FOR_AGENT_LABEL));
    assert.ok(create.includes("spec-review"));
    assert.ok(create.includes("size:L"));
  });

  it("never opens the spec review carrying turboable", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createSpecReviewTicket(SUPERTASK, "Reviews #40.");

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.ok(!create.includes(TURBOABLE_LABEL));
  });

  it("creates every label first, since a project may have none of them", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createSpecReviewTicket(SUPERTASK, "Reviews #40.");

    const calls = await gh.calls();
    const create = callWith(calls, "issue", "create");
    assert.ok(create);
    for (const label of [READY_FOR_AGENT_LABEL, "spec-review", "size:L"]) {
      const labelCreate = callWith(calls, "label", "create", label);
      assert.ok(labelCreate, `${label} should be created`);
      assert.ok(
        calls.indexOf(labelCreate) < calls.indexOf(create),
        `${label} should exist before the spec review that carries it`,
      );
    }
  });

  it("opens the spec review even where every label is already there", async (t) => {
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "label create") echo "label already exists" >&2; exit 1 ;;`,
        `  "issue create") echo ${SPEC_REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/50") echo ${SPEC_REVIEW_ID} ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const specReview = await ghIssueTracker().createSpecReviewTicket(
      SUPERTASK,
      "Reviews #40.",
    );

    assert.equal(specReview.number, 50);
  });

  it("carries the body its caller composed, unchanged", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createSpecReviewTicket(
      SUPERTASK,
      "Reviews #40 and its sub-issues #41, #42.",
    );

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.equal(
      valueOf(create, "--body"),
      "Reviews #40 and its sub-issues #41, #42.",
    );
  });

  it("names the supertask it reviews", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createSpecReviewTicket(SUPERTASK, "Reviews #40.");

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.match(valueOf(create, "--title") ?? "", /#40/);
  });

  it("answers with the spec review it opened, bound to no pull request", async (t) => {
    await recordingGh(t, WORKING);

    const specReview = await ghIssueTracker().createSpecReviewTicket(
      SUPERTASK,
      "Reviews #40.",
    );

    assert.equal(specReview.repo, PILOT);
    assert.equal(specReview.number, 50);
    assert.match(specReview.title, /#40/);
    assert.equal(isSpecReviewTicket(specReview), true);
  });

  it("hangs it off the supertask with the tracker's own sub-issue relationship", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().createSpecReviewTicket(SUPERTASK, "Reviews #40.");

    const link = callWith(await gh.calls(), "api", "--method", "POST");
    assert.ok(link, "the spec review should be linked as a sub-issue");
    assert.ok(link.includes("repos/nadav-alon/pilot/issues/40/sub_issues"));
    assert.equal(valueOf(link, "-F"), `sub_issue_id=${SPEC_REVIEW_ID}`);
  });

  it("falls back to a parent reference in its body where sub-issues are unavailable", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${SPEC_REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/50") echo ${SPEC_REVIEW_ID} ;;`,
        `  "api --method") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const specReview = await ghIssueTracker().createSpecReviewTicket(
      SUPERTASK,
      "Reviews #40.",
    );

    const edit = callWith(await gh.calls(), "issue", "edit");
    assert.ok(edit, "the spec review's body should carry the reference instead");
    assert.equal(valueOf(edit, "--repo"), PILOT);
    const body = valueOf(edit, "--body") ?? "";
    assert.match(body, /^Part of #40\./);
    assert.match(body, /Reviews #40\.$/);
    assert.equal(specReview.number, 50);
  });

  it("says so when linking fails after the spec review was opened", async (t) => {
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${SPEC_REVIEW_URL} ;;`,
        `  *) echo "denied" >&2; exit 1 ;;`,
        `esac`,
      ].join("\n"),
    );

    await assert.rejects(
      ghIssueTracker().createSpecReviewTicket(SUPERTASK, "Reviews #40."),
      /Opened #50 in nadav-alon\/pilot .* could not link it to #40/s,
    );
  });
});

describe("ghIssueTracker.linkSpecReviewTicket", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  const SUPERTASK: Ticket = {
    repo: PILOT,
    number: issueNumber(40),
    title: "Too big for one run",
  };

  const SPEC_REVIEW: Ticket = {
    repo: PILOT,
    number: issueNumber(50),
    title: "Spec review for #40",
    specReview: true,
  };

  /** The spec review's database id, which is what the sub-issues endpoint takes. */
  const SPEC_REVIEW_ID = "2159872999";

  const WORKING = [
    `case "$1 $2" in`,
    `  "api repos/nadav-alon/pilot/issues/50") echo ${SPEC_REVIEW_ID} ;;`,
    `  *) : ;;`,
    `esac`,
  ].join("\n");

  it("hangs the existing spec review off the supertask with the tracker's own sub-issue relationship", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().linkSpecReviewTicket(SPEC_REVIEW, SUPERTASK, async () => "Reviews #40.");

    const link = callWith(await gh.calls(), "api", "--method", "POST");
    assert.ok(link, "the spec review should be linked as a sub-issue");
    assert.ok(link.includes("repos/nadav-alon/pilot/issues/40/sub_issues"));
    assert.equal(valueOf(link, "-F"), `sub_issue_id=${SPEC_REVIEW_ID}`);
  });

  it("never creates a new issue — only links the one it was given", async (t) => {
    const gh = await recordingGh(t, WORKING);

    await ghIssueTracker().linkSpecReviewTicket(SPEC_REVIEW, SUPERTASK, async () => "Reviews #40.");

    const create = callWith(await gh.calls(), "issue", "create");
    assert.equal(create, undefined);
  });

  it("never calls body where the tracker's own sub-issue relationship links it", async (t) => {
    await recordingGh(t, WORKING);
    let called = false;

    await ghIssueTracker().linkSpecReviewTicket(SPEC_REVIEW, SUPERTASK, async () => {
      called = true;
      return "Reviews #40.";
    });

    assert.equal(called, false);
  });

  it("falls back to a parent reference in its body where sub-issues are unavailable", async (t) => {
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "api repos/nadav-alon/pilot/issues/50") echo ${SPEC_REVIEW_ID} ;;`,
        `  "api --method") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    await ghIssueTracker().linkSpecReviewTicket(SPEC_REVIEW, SUPERTASK, async () => "Reviews #40.");

    const edit = callWith(await gh.calls(), "issue", "edit");
    assert.ok(edit, "the spec review's body should carry the reference instead");
    assert.equal(valueOf(edit, "--repo"), PILOT);
    const body = valueOf(edit, "--body") ?? "";
    assert.match(body, /^Part of #40\./);
    assert.match(body, /Reviews #40\.$/);
  });

  it("names the parent's own repo in the fallback reference where it differs from the child's", async (t) => {
    const otherSupertask: Ticket = {
      repo: repoSlug("nadav-alon/other"),
      number: issueNumber(40),
      title: "Too big for one run, elsewhere",
    };
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "api repos/nadav-alon/pilot/issues/50") echo ${SPEC_REVIEW_ID} ;;`,
        `  "api --method") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    await ghIssueTracker().linkSpecReviewTicket(
      SPEC_REVIEW,
      otherSupertask,
      async () => "Reviews nadav-alon/other#40.",
    );

    const edit = callWith(await gh.calls(), "issue", "edit");
    assert.ok(edit, "the spec review's body should carry the reference instead");
    // The edit still targets the child's own repo — only the reference
    // inside the body names the parent's.
    assert.equal(valueOf(edit, "--repo"), PILOT);
    const body = valueOf(edit, "--body") ?? "";
    assert.match(body, /^Part of nadav-alon\/other#40\./);
  });

  it("writes the bare fallback form where the parent's repo differs from the child's only in case", async (t) => {
    const differentlyCasedSupertask: Ticket = {
      repo: repoSlug("Nadav-Alon/Pilot"),
      number: issueNumber(40),
      title: "Too big for one run",
    };
    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "api repos/nadav-alon/pilot/issues/50") echo ${SPEC_REVIEW_ID} ;;`,
        `  "api --method") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    await ghIssueTracker().linkSpecReviewTicket(
      SPEC_REVIEW,
      differentlyCasedSupertask,
      async () => "Reviews #40.",
    );

    const edit = callWith(await gh.calls(), "issue", "edit");
    const body = valueOf(edit, "--body") ?? "";
    assert.match(body, /^Part of #40\./);
  });

  it("says so, naming both tickets, when linking fails", async (t) => {
    await recordingGh(
      t,
      [`case "$1 $2" in`, `  *) echo "denied" >&2; exit 1 ;;`, `esac`].join("\n"),
    );

    await assert.rejects(
      ghIssueTracker().linkSpecReviewTicket(SPEC_REVIEW, SUPERTASK, async () => "Reviews #40."),
      /#50 in nadav-alon\/pilot is already a spec review for #40, but could not link it to #40/,
    );
  });
});

describe("ghIssueTracker.listSubIssues", () => {
  const PILOT = repoSlug("nadav-alon/pilot");

  const SUPERTASK: Ticket = {
    repo: PILOT,
    number: issueNumber(40),
    title: "Too big for one run",
  };

  interface RawSubIssue {
    number: number;
    title: string;
    body?: string;
    state: string;
    labels?: string[];
    repository_url?: string;
  }

  /**
   * A fake `gh` body answering as `--paginate --jq '.[] | {...}'` does: one
   * JSON object per line, not a single array — see `subIssuesIn`. Defaults
   * `repository_url` to the supertask's own repo, since most sub-issues live
   * beside their parent; a test of the cross-repo case names its own.
   */
  function subIssues(entries: RawSubIssue[]): string {
    if (entries.length === 0) {
      return ":";
    }
    const lines = entries
      .map((entry) =>
        JSON.stringify({
          body: "",
          labels: [],
          repository_url: `https://api.github.com/repos/${PILOT}`,
          ...entry,
        }),
      )
      .map((line) => `'${line}'`)
      .join(" ");
    return `printf '%s\\n' ${lines}`;
  }

  it("lists a sub-issue's number and title", async (t) => {
    await recordingGh(
      t,
      subIssues([{ number: 41, title: "Part one", state: "open" }]),
    );

    const listed = await ghIssueTracker().listSubIssues(SUPERTASK);

    assert.deepEqual(listed, [
      { ticket: { repo: PILOT, number: 41, title: "Part one" }, closed: false },
    ]);
  });

  it("reads a closed sub-issue as closed", async (t) => {
    await recordingGh(
      t,
      subIssues([{ number: 41, title: "Part one", state: "closed" }]),
    );

    const listed = await ghIssueTracker().listSubIssues(SUPERTASK);

    assert.equal(listed[0]?.closed, true);
  });

  it("reads a sub-issue's own repo where it differs from the supertask's", async (t) => {
    await recordingGh(
      t,
      subIssues([
        {
          number: 41,
          title: "Part one",
          state: "open",
          repository_url: "https://api.github.com/repos/nadav-alon/other",
        },
      ]),
    );

    const listed = await ghIssueTracker().listSubIssues(SUPERTASK);

    assert.equal(listed[0]?.ticket.repo, "nadav-alon/other");
  });

  it("keeps the supertask's own casing for a same-repo sub-issue, even where repository_url's canonical casing differs", async (t) => {
    await recordingGh(
      t,
      subIssues([
        {
          number: 41,
          title: "Part one",
          state: "open",
          repository_url: "https://api.github.com/repos/Nadav-Alon/Pilot",
        },
      ]),
    );

    const listed = await ghIssueTracker().listSubIssues(SUPERTASK);

    assert.equal(listed[0]?.ticket.repo, PILOT);
  });

  it("throws naming the answer where a sub-issue's repository_url is not shaped like one", async (t) => {
    await recordingGh(
      t,
      subIssues([
        { number: 41, title: "Part one", state: "open", repository_url: "not a url" },
      ]),
    );

    await assert.rejects(
      ghIssueTracker().listSubIssues(SUPERTASK),
      /sub-issue 1.*"repository_url" was not shaped like/,
    );
  });

  it("reads a sub-issue carrying the spec review label as a spec review", async (t) => {
    await recordingGh(
      t,
      subIssues([
        { number: 41, title: "Spec review for #40", state: "closed", labels: ["spec-review"] },
      ]),
    );

    const listed = await ghIssueTracker().listSubIssues(SUPERTASK);

    assert.equal(isSpecReviewTicket(listed[0]!.ticket), true);
  });

  it("lists no sub-issues where the supertask has none", async (t) => {
    await recordingGh(t, subIssues([]));

    const listed = await ghIssueTracker().listSubIssues(SUPERTASK);

    assert.deepEqual(listed, []);
  });

  it("asks the sub-issues endpoint of the supertask it was given", async (t) => {
    const gh = await recordingGh(t, subIssues([]));

    await ghIssueTracker().listSubIssues(SUPERTASK);

    const [call] = await gh.calls();
    assert.deepEqual(call?.slice(0, 2), [
      "api",
      "repos/nadav-alon/pilot/issues/40/sub_issues",
    ]);
  });

  it("throws naming the malformed entry when gh answers with something outside the declared shape", async (t) => {
    await recordingGh(t, `echo '{"title": "Part one", "body": "", "state": "open", "labels": []}'`);

    await assert.rejects(
      ghIssueTracker().listSubIssues(SUPERTASK),
      /sub-issue 1.*"number" must be a number/,
    );
  });

  it("throws naming the answer when a sub-issue's state is neither open nor closed", async (t) => {
    await recordingGh(
      t,
      `echo '{"number": 41, "title": "Part one", "body": "", "state": "draft", "labels": [], "repository_url": "https://api.github.com/repos/nadav-alon/pilot"}'`,
    );

    await assert.rejects(
      ghIssueTracker().listSubIssues(SUPERTASK),
      /"state" was neither "open" nor "closed": "draft"/,
    );
  });
});

describe("ghIssueTracker.wasTurboableAt", () => {
  const PILOT = repoSlug("nadav-alon/pilot");
  const TICKET: Ticket = { repo: PILOT, number: issueNumber(40), title: "Some ticket" };
  const OTHER_TICKET: Ticket = { repo: PILOT, number: issueNumber(41), title: "Another ticket" };

  interface RawEvent {
    event: string;
    label: string;
    created_at: string;
  }

  /**
   * A fake `gh` body answering as `--paginate --jq '.[] | select(...) |
   * {event, label, created_at}'` does: one JSON object per line, not a
   * single array — see `timeline`'s own reader, `labelTimelineEventsIn`.
   */
  function timeline(entries: RawEvent[]): string {
    if (entries.length === 0) {
      return ":";
    }
    const lines = entries
      .map((entry) => JSON.stringify(entry))
      .map((line) => `'${line}'`)
      .join(" ");
    return `printf '%s\\n' ${lines}`;
  }

  it("refuses, not labeled in time, where the ticket's timeline carries no turboable event", async (t) => {
    await recordingGh(t, timeline([]));

    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-02T00:00:00Z"), []),
      { consented: false, reason: "not-labeled-in-time" },
    );
  });

  it("grants consent once turboable was labelled, at and after that instant", async (t) => {
    await recordingGh(
      t,
      timeline([
        { event: "labeled", label: TURBOABLE_LABEL, created_at: "2026-01-01T00:00:00Z" },
      ]),
    );

    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-01T00:00:00Z"), []),
      { consented: true },
    );
    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-02T00:00:00Z"), []),
      { consented: true },
    );
  });

  it("grants consent once turboable was removed and re-labelled before the instant", async (t) => {
    await recordingGh(
      t,
      timeline([
        { event: "labeled", label: TURBOABLE_LABEL, created_at: "2026-01-01T00:00:00Z" },
        { event: "unlabeled", label: TURBOABLE_LABEL, created_at: "2026-01-02T00:00:00Z" },
        { event: "labeled", label: TURBOABLE_LABEL, created_at: "2026-01-03T00:00:00Z" },
      ]),
    );

    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-04T00:00:00Z"), []),
      { consented: true },
    );
  });

  it("refuses, not labeled in time, for a turboable label added after the instant", async (t) => {
    await recordingGh(
      t,
      timeline([
        { event: "labeled", label: TURBOABLE_LABEL, created_at: "2026-01-03T00:00:00Z" },
      ]),
    );

    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-02T00:00:00Z"), []),
      { consented: false, reason: "not-labeled-in-time" },
    );
  });

  it("refuses, not labeled in time, once turboable was added and then removed again before the instant", async (t) => {
    await recordingGh(
      t,
      timeline([
        { event: "labeled", label: TURBOABLE_LABEL, created_at: "2026-01-01T00:00:00Z" },
        { event: "unlabeled", label: TURBOABLE_LABEL, created_at: "2026-01-02T00:00:00Z" },
      ]),
    );

    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-03T00:00:00Z"), []),
      { consented: false, reason: "not-labeled-in-time" },
    );
  });

  it("ignores timeline events for other labels", async (t) => {
    await recordingGh(
      t,
      timeline([
        { event: "labeled", label: READY_FOR_AGENT_LABEL, created_at: "2026-01-01T00:00:00Z" },
      ]),
    );

    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-02T00:00:00Z"), []),
      { consented: false, reason: "not-labeled-in-time" },
    );
  });

  it("asks the paginated timeline endpoint of the ticket it was given", async (t) => {
    const gh = await recordingGh(t, timeline([]));

    await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-02T00:00:00Z"), []);

    const [call] = await gh.calls();
    assert.deepEqual(call?.slice(0, 2), [
      "api",
      "repos/nadav-alon/pilot/issues/40/timeline",
    ]);
    assert.ok(call?.includes("--paginate"), "should paginate the timeline read");
  });

  it("throws naming the malformed entry when gh answers with something outside the declared shape", async (t) => {
    await recordingGh(
      t,
      `echo '{"label": "${TURBOABLE_LABEL}", "created_at": "2026-01-01T00:00:00Z"}'`,
    );

    await assert.rejects(
      ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-02T00:00:00Z"), []),
      /event 1.*"event" must be a string/,
    );
  });

  it("throws naming the answer when an event's created_at is not a valid timestamp", async (t) => {
    await recordingGh(
      t,
      `echo '{"event": "labeled", "label": "${TURBOABLE_LABEL}", "created_at": "not-a-date"}'`,
    );

    await assert.rejects(
      ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-02T00:00:00Z"), []),
      /"created_at" was not a valid timestamp: "not-a-date"/,
    );
  });

  it("refuses, inside a run span, where the grant falls inside another ticket's run span in the same repo", async (t) => {
    await recordingGh(
      t,
      timeline([
        { event: "labeled", label: TURBOABLE_LABEL, created_at: "2026-01-02T00:00:00Z" },
      ]),
    );

    const spans: RunSpan[] = [
      {
        repo: OTHER_TICKET.repo,
        number: OTHER_TICKET.number,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        endedAt: new Date("2026-01-03T00:00:00Z"),
      },
    ];
    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-04T00:00:00Z"), spans),
      { consented: false, reason: "inside-run-span" },
    );
  });

  it("grants consent where every span given leaves the grant uncovered", async (t) => {
    await recordingGh(
      t,
      timeline([
        { event: "labeled", label: TURBOABLE_LABEL, created_at: "2026-01-01T00:00:00Z" },
      ]),
    );

    const spans: RunSpan[] = [
      {
        repo: OTHER_TICKET.repo,
        number: OTHER_TICKET.number,
        startedAt: new Date("2026-01-02T00:00:00Z"),
        endedAt: new Date("2026-01-03T00:00:00Z"),
      },
    ];
    assert.deepEqual(
      await ghIssueTracker().wasTurboableAt(TICKET, new Date("2026-01-04T00:00:00Z"), spans),
      { consented: true },
    );
  });
});

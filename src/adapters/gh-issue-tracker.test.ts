import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { ghIssueTracker } from "./gh-issue-tracker.ts";
import {
  READY_FOR_AGENT_LABEL,
  pullRequestUrl,
  repoSlug,
  type Ticket,
} from "../ports/index.ts";

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

  /** What marks the start of one recorded invocation in the record. */
  const CALL_SEPARATOR = "--- call ---";

  /**
   * A `gh` on PATH for the length of the test, recording how it was called.
   * `body` is the script's, and decides what each invocation answers with.
   *
   * Arguments are recorded NUL-separated rather than one per line, because the
   * argument worth asserting about is `--body`, and a body is several lines.
   * Split on newlines, every assertion about one would silently be an
   * assertion about its first line.
   */
  function recordingGh(t: { after: (fn: () => void) => void }, body: string) {
    const path_ = process.env["PATH"];
    let calls: string;

    const ready = (async () => {
      const bin = await mkdtemp(path.join(tmpdir(), "gh-recording-"));
      calls = path.join(bin, "calls");
      await writeFile(
        path.join(bin, "gh"),
        `#!/bin/sh\nprintf '%s\\0' '${CALL_SEPARATOR}' "$@" >> "${calls}"\n${body}\n`,
        { mode: 0o755 },
      );
      process.env["PATH"] = `${bin}:${path_ ?? ""}`;
    })();

    t.after(() => {
      process.env["PATH"] = path_;
    });

    return {
      ready,
      /** Every invocation, as its argument list, in the order they happened. */
      async calls(): Promise<string[][]> {
        const recorded = await readFile(calls, "utf8").catch(() => "");
        const fields = recorded.split("\0");
        // Every field is terminated rather than separated, so the last split
        // is the empty tail after the final NUL and not an argument.
        fields.pop();

        const parsed: string[][] = [];
        for (const field of fields) {
          if (field === CALL_SEPARATOR) {
            parsed.push([]);
            continue;
          }
          parsed.at(-1)?.push(field);
        }
        return parsed;
      },
    };
  }

  /** A tracker where creating, reading back and linking all succeed. */
  const WORKING = [
    `case "$1 $2" in`,
    `  "issue create") echo ${REVIEW_URL} ;;`,
    `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
    `  *) : ;;`,
    `esac`,
  ].join("\n");

  /** The first call matching `argument`, or undefined if there was none. */
  function callWith(
    calls: string[][],
    ...arguments_: string[]
  ): string[] | undefined {
    return calls.find((call) =>
      arguments_.every((argument) => call.includes(argument)),
    );
  }

  /** The value `gh` was given for `flag`, in one recorded call. */
  function valueOf(call: string[], flag: string): string | undefined {
    const at = call.indexOf(flag);
    return at === -1 ? undefined : call[at + 1];
  }

  it("creates it in the project's own repo, carrying ready-for-agent", async (t) => {
    const gh = recordingGh(t, WORKING);
    await gh.ready;

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create, "the review should be created with `gh issue create`");
    assert.equal(valueOf(create, "--repo"), PILOT);
    assert.equal(valueOf(create, "--label"), READY_FOR_AGENT_LABEL);
  });

  it("names the pull request to review, and the ticket that earned it", async (t) => {
    const gh = recordingGh(t, WORKING);
    await gh.ready;

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const create = callWith(await gh.calls(), "issue", "create");
    assert.ok(create);
    assert.match(valueOf(create, "--title") ?? "", /#7/);

    // The whole body, not its first line: the URL is the one thing a reviewing
    // run cannot work out for itself, and why the review is its own run is the
    // rest of what the ticket has to say.
    const body = valueOf(create, "--body") ?? "";
    assert.match(body, /pull\/12/);
    assert.match(body, /#7/);
    assert.match(body, /run of its own/);
  });

  it("answers with the review it opened", async (t) => {
    const gh = recordingGh(t, WORKING);
    await gh.ready;

    const review = await ghIssueTracker().createReviewTicket(
      TICKET,
      PULL_REQUEST,
    );

    assert.equal(review.repo, PILOT);
    assert.equal(review.number, 42);
    assert.match(review.title, /#7/);
  });

  it("hangs it off the ticket with the tracker's own sub-issue relationship", async (t) => {
    const gh = recordingGh(t, WORKING);
    await gh.ready;

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const link = callWith(await gh.calls(), "api", "--method", "POST");
    assert.ok(link, "the review should be linked as a sub-issue");
    // The parent's endpoint, and the child's database id rather than its
    // number, which is what that endpoint actually takes.
    assert.ok(link.includes("repos/nadav-alon/pilot/issues/7/sub_issues"));
    assert.equal(valueOf(link, "-F"), `sub_issue_id=${REVIEW_ID}`);
  });

  it("falls back to a parent reference in its body where sub-issues are unavailable", async (t) => {
    const gh = recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
        `  "api --method") echo "sub-issues are not available" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );
    await gh.ready;

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
    const gh = recordingGh(
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
    await gh.ready;

    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    // Nothing is POSTed on a blank answer, and the review keeps its parent by
    // falling back rather than by linking to whatever `Number("")` comes to.
    const calls = await gh.calls();
    assert.equal(callWith(calls, "api", "--method", "POST"), undefined);
    const edit = callWith(calls, "issue", "edit");
    assert.ok(edit, "the review should fall back to a parent reference");
    assert.match(valueOf(edit, "--body") ?? "", /^Part of #7\./);
  });

  it("never edits or closes the ticket it reviews", async (t) => {
    const gh = recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  "api repos/nadav-alon/pilot/issues/42") echo ${REVIEW_ID} ;;`,
        `  "api --method") exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );
    await gh.ready;

    // The fallback path, which is the one that writes to an issue body: even
    // there, the issue written to is the review and never its parent.
    await ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST);

    const calls = await gh.calls();
    assert.equal(callWith(calls, "issue", "close"), undefined);
    assert.equal(callWith(calls, "issue", "edit", "7"), undefined);
    assert.equal(callWith(calls, "issue", "comment"), undefined);
  });

  it("says so when the tracker answers with something other than the new issue", async (t) => {
    const gh = recordingGh(t, `echo "Creating issue in nadav-alon/pilot"`);
    await gh.ready;

    // Linking is by number, so a number that was never read is not a number
    // to guess at: better to stop than to hang the review off the wrong issue.
    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      /expected the new issue's URL/,
    );
  });

  it("says so when linking fails after the review was opened", async (t) => {
    const gh = recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue create") echo ${REVIEW_URL} ;;`,
        `  *) echo "denied" >&2; exit 1 ;;`,
        `esac`,
      ].join("\n"),
    );
    await gh.ready;

    // The morning's work is not lost — the review is open and eligible — but
    // it is floating free of its parent, and only this error says so.
    await assert.rejects(
      ghIssueTracker().createReviewTicket(TICKET, PULL_REQUEST),
      /Opened #42 in nadav-alon\/pilot .* could not link it to #7/s,
    );
  });
});

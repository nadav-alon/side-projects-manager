import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";

import { callWith, recordingGh, valueOf } from "../testing/index.ts";

const run = promisify(execFile);

/** The script `.github/workflows/rebase.yml`'s main step runs. */
const SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "scripts",
  "rebase.sh",
);

const REPO = "nadav-alon/pilot";

/**
 * Runs the script the way `rebase.yml` does — same environment variables,
 * only `RUNNER_TEMP` supplied here rather than by Actions — against whichever
 * `gh` a test has put on `PATH`.
 */
async function runRebaseScript(env: Record<string, string>): Promise<void> {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "rebase-runner-temp-"));
  await run("bash", [SCRIPT], {
    env: { ...process.env, RUNNER_TEMP: runnerTemp, ...env },
  });
}

/**
 * A `gh` that answers every call the script makes on its way to opening a
 * rebase ticket: no rebase ticket open yet, and the new one created at
 * `newIssueUrl`. `prResponse` is the body of whichever read tells the script
 * which pull request and ticket it's acting on — `pr list` for an
 * implementation ticket, `pr view` for a comment on the pull request itself.
 */
function fakeGh(options: {
  prCommand: "list" | "view";
  prResponse: string;
  newIssueUrl: string;
}): string {
  return [
    `case "$1" in`,
    `  pr)`,
    `    case "$2" in`,
    `      ${options.prCommand}) cat <<'JSON'`,
    options.prResponse,
    `JSON`,
    `        ;;`,
    `      edit) exit 0 ;;`,
    `    esac`,
    `    ;;`,
    `  issue)`,
    `    case "$2" in`,
    `      list) echo '[]' ;;`,
    `      create) printf 'Creating issue in ${REPO}\\n%s\\n' '${options.newIssueUrl}' ;;`,
    `    esac`,
    `    ;;`,
    `  label) exit 0 ;;`,
    `  api)`,
    `    case "$*" in`,
    `      *"--jq .id"*) echo '"gid-1"' ;;`,
    `      *"sub_issues"*) exit 0 ;;`,
    `      *"reactions"*) exit 0 ;;`,
    `      *"/comments"*) exit 0 ;;`,
    `    esac`,
    `    ;;`,
    `esac`,
  ].join("\n");
}

describe("rebase.sh", () => {
  it("opens a rebase ticket for an implementation ticket whose only closing pull request is open and ready", async (t: TestContext) => {
    const gh = await recordingGh(
      t,
      fakeGh({
        prCommand: "list",
        prResponse: JSON.stringify([
          { number: 7, url: `https://github.com/${REPO}/pull/7`, body: "Closes #42" },
        ]),
        newIssueUrl: `https://github.com/${REPO}/issues/99`,
      }),
    );

    await runRebaseScript({
      GH_TOKEN: "test-token",
      REPO,
      ISSUE_NUMBER: "42",
      ISSUE_BODY: "A ticket with no pull request line of its own.",
      IS_PULL_REQUEST: "false",
      COMMENT_ID: "555",
      COMMENT_BODY: "/rebase",
    });

    const calls = await gh.calls();
    const created = callWith(calls, "issue", "create");
    assert.equal(valueOf(created, "--title"), "Rebase #7");
    assert.equal(
      valueOf(created, "--body"),
      `Rebase https://github.com/${REPO}/pull/7, the pull request opened for #42.`,
    );

    const replied = callWith(calls, "api", `repos/${REPO}/issues/42/comments`);
    assert.equal(
      valueOf(replied, "-f"),
      `body=Opened https://github.com/${REPO}/issues/99 to rebase.`,
    );
  });

  it("opens a rebase ticket when /rebase is commented directly on a ready pull request", async (t: TestContext) => {
    const gh = await recordingGh(
      t,
      fakeGh({
        prCommand: "view",
        prResponse: JSON.stringify({
          number: 7,
          state: "OPEN",
          body: "Closes #42",
          url: `https://github.com/${REPO}/pull/7`,
        }),
        newIssueUrl: `https://github.com/${REPO}/issues/100`,
      }),
    );

    await runRebaseScript({
      GH_TOKEN: "test-token",
      REPO,
      ISSUE_NUMBER: "7",
      ISSUE_BODY: "",
      IS_PULL_REQUEST: "true",
      COMMENT_ID: "777",
      COMMENT_BODY: "/rebase",
    });

    const calls = await gh.calls();
    const created = callWith(calls, "issue", "create");
    assert.equal(valueOf(created, "--title"), "Rebase #7");
    assert.equal(
      valueOf(created, "--body"),
      `Rebase https://github.com/${REPO}/pull/7, the pull request opened for #42.`,
    );

    const replied = callWith(calls, "api", `repos/${REPO}/issues/7/comments`);
    assert.equal(
      valueOf(replied, "-f"),
      `body=Opened https://github.com/${REPO}/issues/100 to rebase.`,
    );
  });
});

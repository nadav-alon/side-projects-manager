import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";

import { callWith, recordingGh } from "../testing/index.ts";

const run = promisify(execFile);

/** The script `.github/workflows/recheck-adr-numbers.yml` runs. */
const SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "scripts",
  "recheck-adr-numbers.sh",
);

const REPO = "nadav-alon/pilot";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  return stdout.trim();
}

async function commitAdr(cwd: string, name: string, content = ""): Promise<void> {
  await mkdir(path.join(cwd, "docs", "adr"), { recursive: true });
  await writeFile(path.join(cwd, "docs", "adr", name), content);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", name);
}

/**
 * An origin whose master holds `0012-base.md`, with pull request 7 cut from
 * it adding `pullFile` and master then moving on by adding `masterFile`.
 * Returns pull request 7's head.
 */
async function originWithPullRequest(
  origin: string,
  pullFile: string,
  masterFile: string,
): Promise<string> {
  await git(origin, "init", "--quiet", "-b", "master");
  await commitAdr(origin, "0012-base.md");

  await git(origin, "checkout", "--quiet", "-b", "b");
  await commitAdr(origin, pullFile, "pull request");
  const head = await git(origin, "rev-parse", "HEAD");
  await git(origin, "update-ref", "refs/pull/7/head", head);

  await git(origin, "checkout", "--quiet", "master");
  await commitAdr(origin, masterFile, "master");
  return head;
}

/** Runs the script from a clone of `origin`, with `gh` listing pull request 7 at `head`. */
async function recheck(
  t: TestContext,
  origin: string,
  head: string,
  cloneArgs: string[] = [],
) {
  const work = await mkdtemp(path.join(tmpdir(), "recheck-work-"));
  await git(work, "clone", "--quiet", ...cloneArgs, `file://${origin}`, ".");
  const gh = await recordingGh(
    t,
    [
      `case "$1 $2" in`,
      `  "pr list") echo '7 ${head}' ;;`,
      `esac`,
    ].join("\n"),
  );
  const result = await run("bash", [SCRIPT], {
    cwd: work,
    env: {
      ...process.env,
      GH_TOKEN: "test-token",
      REPO,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "99",
    },
  }).catch((error: unknown) => ({ error }));
  const posted = callWith(
    await gh.calls(),
    "api",
    `repos/${REPO}/statuses/${head}`,
  );
  return { result, posted };
}

describe("recheck-adr-numbers.sh", () => {
  it("fails a pull request whose number master claimed after the pull request's own run, naming the number and linking the run that names both files", async (t: TestContext) => {
    const origin = await mkdtemp(path.join(tmpdir(), "recheck-origin-"));
    const head = await originWithPullRequest(origin, "0013-x.md", "0013-y.md");

    const { result, posted } = await recheck(t, origin, head);

    assert.ok(posted, "a status was posted on the pull request's head");
    assert.ok(posted.includes("state=failure"));
    assert.ok(posted.includes("context=ADR numbers are unique"));
    assert.ok(
      posted.includes(
        "target_url=https://github.com/nadav-alon/pilot/actions/runs/99",
      ),
    );
    const description = posted.find((a) => a.startsWith("description="));
    assert.match(description ?? "", /ADR 0013 claimed twice/);
    assert.ok("stdout" in result);
    assert.match(result.stdout, /ADR 0013 is claimed by 0013-x\.md and 0013-y\.md/);
  });

  it("posts success for a pull request whose merge result claims no number twice", async (t: TestContext) => {
    const origin = await mkdtemp(path.join(tmpdir(), "recheck-origin-"));
    const head = await originWithPullRequest(origin, "0013-x.md", "0014-y.md");

    const { posted } = await recheck(t, origin, head);

    assert.ok(posted?.includes("state=success"));
  });

  it("replaces an earlier status on a conflicting pull request with an error", async (t: TestContext) => {
    const origin = await mkdtemp(path.join(tmpdir(), "recheck-origin-"));
    const head = await originWithPullRequest(origin, "0013-x.md", "0013-x.md");

    const { posted } = await recheck(t, origin, head);

    assert.ok(posted?.includes("state=error"));
    assert.ok(posted?.includes("description=Not checked: merge conflict"));
  });

  it("fails the run, posting nothing, when a merge fails for a reason other than a conflict", async (t: TestContext) => {
    const origin = await mkdtemp(path.join(tmpdir(), "recheck-origin-"));
    const head = await originWithPullRequest(origin, "0013-x.md", "0014-y.md");

    // A depth-1 checkout leaves master's tip with no history to merge with.
    const { result, posted } = await recheck(t, origin, head, ["--depth", "1"]);

    assert.ok("error" in result, "the script exited non-zero");
    assert.equal(posted, undefined);
  });
});

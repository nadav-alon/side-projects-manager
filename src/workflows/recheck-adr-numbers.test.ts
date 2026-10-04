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

async function commitAdr(cwd: string, name: string): Promise<void> {
  await mkdir(path.join(cwd, "docs", "adr"), { recursive: true });
  await writeFile(path.join(cwd, "docs", "adr", name), "");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", name);
}

describe("recheck-adr-numbers.sh", () => {
  it("fails a pull request whose number master claimed after the pull request's own run, naming both files", async (t: TestContext) => {
    const origin = await mkdtemp(path.join(tmpdir(), "recheck-origin-"));
    await git(origin, "init", "--quiet", "-b", "master");
    await commitAdr(origin, "0012-base.md");

    // PR B was cut from this master and claims 0013.
    await git(origin, "checkout", "--quiet", "-b", "b");
    await commitAdr(origin, "0013-x.md");
    const head = await git(origin, "rev-parse", "HEAD");
    await git(origin, "update-ref", "refs/pull/7/head", head);

    // PR A then merges to master with the same number.
    await git(origin, "checkout", "--quiet", "master");
    await commitAdr(origin, "0013-y.md");

    const work = await mkdtemp(path.join(tmpdir(), "recheck-work-"));
    await git(work, "clone", "--quiet", origin, ".");

    const gh = await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "pr list") echo '7 ${head}' ;;`,
        `esac`,
      ].join("\n"),
    );

    await run("bash", [SCRIPT], {
      cwd: work,
      env: { ...process.env, GH_TOKEN: "test-token", REPO },
    });

    const posted = callWith(
      await gh.calls(),
      "api",
      `repos/${REPO}/statuses/${head}`,
    );
    assert.ok(posted, "a status was posted on the pull request's head");
    assert.ok(posted.includes("state=failure"));
    assert.ok(posted.includes("context=ADR numbers are unique"));
    const description = posted.find((a) => a.startsWith("description="));
    assert.match(description ?? "", /ADR 0013 is claimed by 0013-x\.md and 0013-y\.md/);
  });
});

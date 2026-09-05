import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  containerSandbox,
  readAgentRun,
  type Container,
} from "./container-sandbox.ts";
import { repoSlug, tokenCount, type Ticket } from "../ports/index.ts";

const run = promisify(execFile);

const TICKET: Ticket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 7,
  title: "Run a ticket in the sandbox",
};

const BRANCH = "issue-7-run-a-ticket-in-the-sandbox";

/**
 * A project checkout with one commit on `main`, which is what the repo host
 * hands the sandbox. Only the git half of the adapter is exercised here; the
 * container half needs docker and a credential, and is injected instead.
 */
async function checkout(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "sandbox-"));
  await run("git", ["init", "--initial-branch=main", directory]);
  await identify(directory);
  await writeFile(path.join(directory, "README.md"), "pilot\n");
  await run("git", ["-C", directory, "add", "."]);
  await run("git", ["-C", directory, "commit", "--message", "First"]);
  return directory;
}

/** What the sandbox image does for a real run, done here for a fake one. */
async function identify(directory: string): Promise<void> {
  await run("git", ["-C", directory, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test"]);
}

async function headOf(directory: string, revision = "HEAD"): Promise<string> {
  const { stdout } = await run("git", ["-C", directory, "rev-parse", revision]);
  return stdout.trim();
}

async function branchesIn(directory: string): Promise<string[]> {
  const { stdout } = await run("git", [
    "-C",
    directory,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return stdout.split("\n").filter((line) => line !== "");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** An agent that commits `files` and reports having spent `tokensUsed`. */
function agentCommitting(
  files: string[],
  tokensUsed = 0,
  output = "",
): Container {
  return async (directory) => {
    await identify(directory);
    for (const file of files) {
      await writeFile(path.join(directory, file), `${file}\n`);
      await run("git", ["-C", directory, "add", "."]);
      await run("git", ["-C", directory, "commit", "--message", `Add ${file}`]);
    }
    return { output, tokensUsed: tokenCount(tokensUsed) };
  };
}

describe("containerSandbox", () => {
  it("runs the agent on a workspace of its own, never on the checkout", async () => {
    const directory = await checkout();
    const seen: string[] = [];
    const sandbox = containerSandbox(async (mounted) => {
      seen.push(mounted);
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.run(TICKET, directory);

    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], directory);
  });

  /**
   * The workspace is bind-mounted into the container on its own. A `git
   * worktree` would put a `.git` *file* there pointing at an absolute path in
   * the parent repository, which does not exist inside the container — so the
   * agent could not run git at all, and a run's whole product is commits.
   */
  it("gives the agent a repository that stands on its own", async () => {
    const directory = await checkout();
    let checked = false;
    const sandbox = containerSandbox(async (mounted) => {
      const git = await stat(path.join(mounted, ".git"));
      assert.ok(git.isDirectory(), ".git must be a directory, not a pointer");
      checked = true;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.run(TICKET, directory);

    assert.ok(checked);
  });

  it("leaves the agent's commits on a branch named for the ticket", async () => {
    const directory = await checkout();
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    const result = await sandbox.run(TICKET, directory);

    assert.equal(result.branch, BRANCH);
    assert.deepEqual(await branchesIn(directory), [BRANCH, "main"]);
    assert.equal(await headOf(directory, BRANCH), result.commits.at(-1));
  });

  it("leaves the branch the checkout is on untouched", async () => {
    const directory = await checkout();
    const before = await headOf(directory);
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    await sandbox.run(TICKET, directory);

    assert.equal(await headOf(directory), before);
    assert.equal(await headOf(directory, "main"), before);
  });

  it("returns every commit the agent made, oldest first", async () => {
    const directory = await checkout();
    const sandbox = containerSandbox(agentCommitting(["one.txt", "two.txt"]));

    const result = await sandbox.run(TICKET, directory);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "log",
      "--format=%H %s",
      "--reverse",
      `main..${result.branch}`,
    ]);
    const log = stdout.trim().split("\n");
    assert.deepEqual(
      log.map((line) => line.split(" ")[0]),
      result.commits,
    );
    assert.match(log[0] ?? "", /Add one\.txt/);
    assert.match(log[1] ?? "", /Add two\.txt/);
  });

  it("reports no commits, and leaves no branch, when the agent committed nothing", async () => {
    const directory = await checkout();
    const sandbox = containerSandbox(agentCommitting([]));

    const result = await sandbox.run(TICKET, directory);

    assert.deepEqual(result.commits, []);
    assert.deepEqual(await branchesIn(directory), ["main"]);
  });

  it("returns the agent's own output and what the run cost", async () => {
    const directory = await checkout();
    const sandbox = containerSandbox(
      agentCommitting([], 42_000, "implemented the thing"),
    );

    const result = await sandbox.run(TICKET, directory);

    assert.equal(result.output, "implemented the thing");
    assert.equal(result.tokensUsed, tokenCount(42_000));
  });

  it("takes the workspace away and leaves the branch behind", async () => {
    const directory = await checkout();
    let workspace = "";
    const commit = agentCommitting(["one.txt"]);
    const sandbox = containerSandbox(async (mounted, prompt) => {
      workspace = mounted;
      return commit(mounted, prompt);
    });

    const result = await sandbox.run(TICKET, directory);

    assert.equal(await exists(workspace), false);
    assert.ok((await branchesIn(directory)).includes(result.branch));
  });

  it("takes the workspace away even when the agent fails", async () => {
    const directory = await checkout();
    let workspace = "";
    const sandbox = containerSandbox(async (mounted) => {
      workspace = mounted;
      throw new Error("the agent gave up");
    });

    await assert.rejects(sandbox.run(TICKET, directory), /gave up/);

    assert.equal(await exists(workspace), false);
  });

  it("gives a ticket that comes round again a branch of its own", async () => {
    const directory = await checkout();
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    const first = await sandbox.run(TICKET, directory);
    const second = await sandbox.run(TICKET, directory);

    assert.equal(first.branch, BRANCH);
    assert.equal(second.branch, `${BRANCH}-2`);
    assert.deepEqual(await branchesIn(directory), [
      BRANCH,
      `${BRANCH}-2`,
      "main",
    ]);
  });

  it("runs one agent at a time, however many runs are asked for at once", async () => {
    const directory = await checkout();
    const events: string[] = [];
    const sandbox = containerSandbox(async () => {
      events.push("enter");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("leave");
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await Promise.all([
      sandbox.run(TICKET, directory),
      sandbox.run({ ...TICKET, number: 8, title: "Another" }, directory),
      sandbox.run({ ...TICKET, number: 9, title: "A third" }, directory),
    ]);

    assert.deepEqual(events, [
      "enter",
      "leave",
      "enter",
      "leave",
      "enter",
      "leave",
    ]);
  });

  it("keeps queued runs going when one of them fails", async () => {
    const directory = await checkout();
    let first = true;
    const sandbox = containerSandbox(async () => {
      if (first) {
        first = false;
        throw new Error("the agent gave up");
      }
      return { output: "second", tokensUsed: tokenCount(0) };
    });

    const [failed, succeeded] = await Promise.allSettled([
      sandbox.run(TICKET, directory),
      sandbox.run({ ...TICKET, number: 8, title: "Another" }, directory),
    ]);

    assert.equal(failed?.status, "rejected");
    assert.equal(succeeded?.status, "fulfilled");
  });
});

describe("readAgentRun", () => {
  it("reads the agent's result and totals every token field", () => {
    const stdout = JSON.stringify({
      result: "implemented the thing",
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 8,
      },
    });

    assert.deepEqual(readAgentRun(stdout), {
      output: "implemented the thing",
      tokensUsed: tokenCount(15),
    });
  });

  it("counts the fields it was given and no others", () => {
    const stdout = JSON.stringify({
      result: "done",
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    assert.equal(readAgentRun(stdout).tokensUsed, tokenCount(7));
  });

  it("keeps output it cannot parse, and charges nothing for it", () => {
    const stdout = "claude: command not found";

    assert.deepEqual(readAgentRun(stdout), {
      output: stdout,
      tokensUsed: tokenCount(0),
    });
  });

  it("keeps the raw envelope when it carries no result", () => {
    const stdout = JSON.stringify({ usage: { input_tokens: 5 } });

    const agent = readAgentRun(stdout);

    assert.equal(agent.output, stdout);
    assert.equal(agent.tokensUsed, tokenCount(5));
  });

  it("charges nothing when the envelope reports no usage", () => {
    const stdout = JSON.stringify({ result: "done" });

    assert.equal(readAgentRun(stdout).tokensUsed, tokenCount(0));
  });
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  containerSandbox,
  dockerCommand,
  readAgentRun,
  type Container,
} from "./container-sandbox.ts";
import {
  checkout,
  repoSlug,
  tokenCount,
  usd,
  type Checkout,
  type Ticket,
} from "../ports/index.ts";

const run = promisify(execFile);

const TICKET: Ticket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 7,
  title: "Run a ticket in the sandbox",
};

const BRANCH = "issue-7-run-a-ticket-in-the-sandbox";

/** What the loop would have taken off the budget for one run. */
const CEILING = usd(5);

/**
 * A project checkout with one commit on `main`, which is what the repo host
 * hands the sandbox. Only the git half of the adapter is exercised here; the
 * container half needs docker and a credential, and is injected instead.
 */
async function project(): Promise<Checkout> {
  const directory = checkout(await mkdtemp(path.join(tmpdir(), "sandbox-")));
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
  it("runs the agent on a clone of its own, never on the checkout", async () => {
    const directory = await project();
    const seen: string[] = [];
    const sandbox = containerSandbox(async (mounted) => {
      seen.push(mounted);
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], directory);
  });

  /**
   * The clone is bind-mounted into the container on its own. A `git worktree`
   * would put a `.git` *file* there pointing at an absolute path in the parent
   * repository, which does not exist inside the container — so the agent could
   * not run git at all, and a run's whole product is commits.
   */
  it("gives the agent a repository that stands on its own", async () => {
    const directory = await project();
    let checked = false;
    const sandbox = containerSandbox(async (mounted) => {
      const git = await stat(path.join(mounted, ".git"));
      assert.ok(git.isDirectory(), ".git must be a directory, not a pointer");
      checked = true;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.ok(checked);
  });

  /**
   * The clone's `origin` is a path on this filesystem, so `gh` has no repo to
   * resolve from it. Without the flag the agent cannot read its ticket and
   * implements the title.
   */
  it("tells the agent which GitHub repo its ticket is in", async () => {
    const directory = await project();
    let asked = "";
    const sandbox = containerSandbox(async (_mounted, prompt) => {
      asked = prompt;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.match(asked, /gh issue view 7 --repo nadav-alon\/pilot/);
  });

  it("leaves the agent's commits on a branch named for the ticket", async () => {
    const directory = await project();
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(result.branch, BRANCH);
    assert.deepEqual(await branchesIn(directory), [BRANCH, "main"]);
    assert.equal(await headOf(directory, BRANCH), result.commits.at(-1));
  });

  it("leaves the branch the checkout is on untouched", async () => {
    const directory = await project();
    const before = await headOf(directory);
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(await headOf(directory), before);
    assert.equal(await headOf(directory, "main"), before);
  });

  it("returns every commit the agent made, oldest first", async () => {
    const directory = await project();
    const sandbox = containerSandbox(agentCommitting(["one.txt", "two.txt"]));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

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
    const directory = await project();
    const sandbox = containerSandbox(agentCommitting([]));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.deepEqual(result.commits, []);
    assert.deepEqual(await branchesIn(directory), ["main"]);
  });

  it("returns the agent's own output and what the run cost", async () => {
    const directory = await project();
    const sandbox = containerSandbox(
      agentCommitting([], 42_000, "implemented the thing"),
    );

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(result.output, "implemented the thing");
    assert.equal(result.tokensUsed, tokenCount(42_000));
    assert.equal(result.failure, undefined);
  });

  it("takes the clone away and leaves the branch behind", async () => {
    const directory = await project();
    let clone = "";
    const commit = agentCommitting(["one.txt"]);
    const sandbox = containerSandbox(async (mounted, prompt) => {
      clone = mounted;
      return commit(mounted, prompt, CEILING);
    });

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(await exists(clone), false);
    assert.ok((await branchesIn(directory)).includes(result.branch));
  });

  it("takes the clone away even when the agent fails", async () => {
    const directory = await project();
    let clone = "";
    const sandbox = containerSandbox(async (mounted) => {
      clone = mounted;
      throw new Error("the agent gave up");
    });

    await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(await exists(clone), false);
  });

  /**
   * A failed agent is still a run. Throwing here would lose the commits it
   * made before it stopped, what it said about why, and the tokens it spent —
   * and the loop records all three against the project.
   */
  it("reports a failed agent rather than throwing, keeping what it did", async () => {
    const directory = await project();
    const commit = agentCommitting(["one.txt"]);
    const sandbox = containerSandbox(async (mounted, prompt) => {
      await commit(mounted, prompt, CEILING);
      throw new Error("the agent gave up");
    });

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.match(result.failure ?? "", /gave up/);
    assert.match(result.output, /gave up/);
    assert.equal(result.commits.length, 1);
    assert.deepEqual(await branchesIn(directory), [BRANCH, "main"]);
  });

  it("gives a ticket that comes round again a branch of its own", async () => {
    const directory = await project();
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    const first = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });
    const second = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(first.branch, BRANCH);
    assert.equal(second.branch, `${BRANCH}-2`);
    assert.deepEqual(await branchesIn(directory), [
      BRANCH,
      `${BRANCH}-2`,
      "main",
    ]);
  });

  it("runs one agent at a time, however many runs are asked for at once", async () => {
    const directory = await project();
    const events: string[] = [];
    const sandbox = containerSandbox(async () => {
      events.push("enter");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("leave");
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await Promise.all([
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
      sandbox.run({
        ticket: { ...TICKET, number: 8, title: "Another" },
        checkout: directory,
        spendCeiling: CEILING,
      }),
      sandbox.run({
        ticket: { ...TICKET, number: 9, title: "A third" },
        checkout: directory,
        spendCeiling: CEILING,
      }),
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
    const directory = await project();
    let first = true;
    const sandbox = containerSandbox(async () => {
      if (first) {
        first = false;
        throw new Error("the agent gave up");
      }
      return { output: "second", tokensUsed: tokenCount(0) };
    });

    const [failed, succeeded] = await Promise.all([
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
      sandbox.run({
        ticket: { ...TICKET, number: 8, title: "Another" },
        checkout: directory,
        spendCeiling: CEILING,
      }),
    ]);

    assert.match(failed?.failure ?? "", /gave up/);
    assert.equal(succeeded?.failure, undefined);
    assert.equal(succeeded?.output, "second");
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

  /** A run that went wrong says so on stderr, and nowhere else. */
  it("keeps the diagnostics a failing run wrote to stderr", () => {
    const stdout = JSON.stringify({ result: "gave up" });

    const agent = readAgentRun(stdout, "Error: no such image\n");

    assert.match(agent.output, /gave up/);
    assert.match(agent.output, /no such image/);
  });

  it("reports stderr alone when the run said nothing else", () => {
    assert.equal(
      readAgentRun("", "docker: command not found\n").output,
      "docker: command not found\n",
    );
  });
});

/**
 * The spend ceiling is the only thing standing between one pathological
 * ticket and the whole week, and nothing the manager can observe enforces it:
 * once the container is up, the agent CLI is on its own. So what is asserted
 * here is the argument list itself.
 */
describe("dockerCommand", () => {
  const CLONE = checkout("/tmp/clone");

  it("hands the agent CLI the run's spend ceiling", () => {
    const command = dockerCommand(CLONE, "do the thing", usd(2.5));

    const ceiling = command.indexOf("--max-budget-usd");
    assert.notEqual(ceiling, -1);
    assert.equal(command[ceiling + 1], "2.5");
  });

  it("asks for print mode, which is the only mode the ceiling applies in", () => {
    const command = dockerCommand(CLONE, "do the thing", usd(5));

    assert.ok(command.includes("--print"));
  });

  it("mounts the clone and never the developer's own checkout", () => {
    const command = dockerCommand(CLONE, "do the thing", usd(5));

    assert.ok(command.includes(`${CLONE}:/repo`));
  });
});

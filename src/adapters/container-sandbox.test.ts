import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  AgentNeverRan,
  containerSandbox,
  dockerCommand,
  dockerNeverRan,
  readAgentRun,
  type Container,
  type Mount,
} from "./container-sandbox.ts";
import {
  checkout,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  usd,
  type Checkout,
  type ReviewTicket,
  type Ticket,
} from "../ports/index.ts";

const run = promisify(execFile);

const TICKET: Ticket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 7,
  title: "Run a ticket in the sandbox",
};

const REVIEW_TICKET: ReviewTicket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 42,
  title: "Review the draft pull request for #7",
  pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
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
  return async ({ directory }) => {
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
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
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
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
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
    const sandbox = containerSandbox(async ({ prompt }) => {
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
    const sandbox = containerSandbox(async (options) => {
      clone = options.directory;
      return commit(options);
    });

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(await exists(clone), false);
    assert.ok((await branchesIn(directory)).includes(result.branch));
  });

  it("takes the clone away even when the agent fails", async () => {
    const directory = await project();
    let clone = "";
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
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
    const sandbox = containerSandbox(async (options) => {
      await commit(options);
      throw new Error("the agent gave up");
    });

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.match(result.failure ?? "", /gave up/);
    assert.match(result.output, /gave up/);
    assert.equal(result.commits.length, 1);
    assert.deepEqual(await branchesIn(directory), [BRANCH, "main"]);
  });

  /**
   * The line the loop reads a failure's kind off. A container that never
   * started the agent has no commits, output or spend to keep, and reporting it
   * as a run would tell the ticket its agent gave up.
   */
  it("rejects, rather than reporting a failed agent, when the agent never ran", async () => {
    const directory = await project();
    let clone = "";
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
      clone = mounted;
      throw new AgentNeverRan("docker is not running");
    });

    await assert.rejects(
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
      /docker is not running/,
    );
    assert.equal(await exists(clone), false);
    assert.deepEqual(await branchesIn(directory), ["main"]);
  });

  it("refuses to start an agent that has no credential to sign in with", async (t) => {
    const directory = await project();
    const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    t.after(() => {
      if (token !== undefined) {
        process.env["CLAUDE_CODE_OAUTH_TOKEN"] = token;
      }
    });

    // The real container, which asks before it ever reaches docker — so this
    // needs no docker to run, and would pass the same with it.
    await assert.rejects(
      containerSandbox().run({
        ticket: TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
      (error: Error) =>
        error instanceof AgentNeverRan &&
        /CLAUDE_CODE_OAUTH_TOKEN/.test(error.message),
    );
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

describe("containerSandbox.review", () => {
  it("mounts a clone of its own, read-only", async () => {
    const directory = await project();
    const mounts: (Mount | undefined)[] = [];
    const seen: string[] = [];
    const sandbox = containerSandbox(async ({ directory: mounted, mount }) => {
      seen.push(mounted);
      mounts.push(mount);
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], directory);
    assert.deepEqual(mounts, ["ro"]);
  });

  it("names the pull request to review, since the clone's origin can't say", async () => {
    const directory = await project();
    let asked = "";
    const sandbox = containerSandbox(async ({ prompt }) => {
      asked = prompt;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.match(asked, new RegExp(REVIEW_TICKET.pullRequest.replace(/\//g, "\\/")));
    assert.match(asked, /mattpocock-skills:code-review/);
  });

  /**
   * The skill's own last step only aggregates the two reports — posting is
   * the prompt's to spell out, and a finding dropped as one summary comment
   * loses the very context (the line it is about) that makes it useful.
   */
  it("asks for each finding posted inline, not as one aggregated comment", async () => {
    const directory = await project();
    let asked = "";
    const sandbox = containerSandbox(async ({ prompt }) => {
      asked = prompt;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.match(asked, /pulls\/<number>\/reviews/);
    assert.match(asked, /"comments":\s*\[\{"path"/);
    assert.doesNotMatch(asked, /gh pr comment/);
  });

  /**
   * A reviewer has nothing to commit, and nothing here ever fetches a branch
   * back — unlike a run, whose whole product is the branch it leaves.
   */
  it("creates no branch and leaves the checkout untouched, whatever the agent does", async () => {
    const directory = await project();
    const before = await headOf(directory);
    const sandbox = containerSandbox(async () => ({
      output: "",
      tokensUsed: tokenCount(0),
    }));

    await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.deepEqual(await branchesIn(directory), ["main"]);
    assert.equal(await headOf(directory), before);
  });

  it("returns the agent's own output and what the review cost", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      output: "posted findings",
      tokensUsed: tokenCount(9_000),
    }));

    const result = await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.output, "posted findings");
    assert.equal(result.tokensUsed, tokenCount(9_000));
    assert.equal(result.failure, undefined);
  });

  it("reports a failed agent rather than throwing", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => {
      throw new Error("the agent gave up");
    });

    const result = await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.match(result.failure ?? "", /gave up/);
    assert.match(result.output, /gave up/);
  });

  it("takes the clone away once the review finishes", async () => {
    const directory = await project();
    let clone = "";
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
      clone = mounted;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(await exists(clone), false);
  });

  /**
   * `GH_REVIEW_TOKEN` is what stands between a reviewer and the developer's
   * own push-capable credential — see `Mount` and `envFor` in
   * container-sandbox.ts. Absent, a reviewer must not silently fall back to
   * the implementation's token: that would leave the AC this closes ("cannot
   * push, prevented rather than merely discouraged") unenforced again.
   */
  it("refuses to start a reviewer with no separately scoped credential", async (t) => {
    const directory = await project();
    const oauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    const reviewToken = process.env["GH_REVIEW_TOKEN"];
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "test-oauth-token";
    delete process.env["GH_REVIEW_TOKEN"];
    t.after(() => {
      if (oauth === undefined) {
        delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
      } else {
        process.env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth;
      }
      if (reviewToken !== undefined) {
        process.env["GH_REVIEW_TOKEN"] = reviewToken;
      }
    });

    // The real container, which asks before it ever reaches docker — so this
    // needs no docker to run, and would pass the same with it.
    await assert.rejects(
      containerSandbox().review({
        ticket: REVIEW_TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
      (error: Error) =>
        error instanceof AgentNeverRan &&
        /GH_REVIEW_TOKEN/.test(error.message),
    );
  });

  it("shares the one lane with implementation runs on the same sandbox", async () => {
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
      sandbox.review({
        ticket: REVIEW_TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
    ]);

    assert.deepEqual(events, ["enter", "leave", "enter", "leave"]);
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

  /**
   * The envelope a sandbox that grants the agent nothing actually sends back,
   * trimmed to the fields that matter. Note `is_error: false` and the ordinary
   * `result`: nothing outside `permission_denials` says the run was refused,
   * which is why a manager that reads only `result` reports it as a morning
   * where the agent simply found nothing to do.
   */
  it("says which tools the agent was refused", () => {
    const stdout = JSON.stringify({
      is_error: false,
      result: "It looks like the write permission was denied.",
      usage: { input_tokens: 6, output_tokens: 219 },
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "git commit -m x" } },
        { tool_name: "Write", tool_input: { file_path: "/repo/probe.txt" } },
      ],
    });

    const agent = readAgentRun(stdout);

    assert.match(agent.output, /refused these tools/);
    assert.match(agent.output, /Bash/);
    assert.match(agent.output, /Write/);
    // The agent's own words are kept as well: what it was refused explains
    // the run, but what it said is still what a developer reads first.
    assert.match(agent.output, /write permission was denied/);
  });

  it("names each refused tool once, however often it was refused", () => {
    const stdout = JSON.stringify({
      result: "denied",
      permission_denials: [
        { tool_name: "Bash" },
        { tool_name: "Bash" },
        { tool_name: "Bash" },
      ],
    });

    const denials = readAgentRun(stdout).output.match(/Bash/g) ?? [];
    assert.equal(denials.length, 1);
  });

  /**
   * A run nobody refused anything reads exactly as it did before, so the note
   * stays a signal rather than a line on every hand-back comment.
   */
  it("says nothing about refusals when there were none", () => {
    const stdout = JSON.stringify({
      result: "done",
      permission_denials: [],
    });

    assert.equal(readAgentRun(stdout).output, "done");
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
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(2.5),
      mount: "rw",
    });

    const ceiling = command.indexOf("--max-budget-usd");
    assert.notEqual(ceiling, -1);
    assert.equal(command[ceiling + 1], "2.5");
  });

  it("asks for print mode, which is the only mode the ceiling applies in", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(5),
      mount: "rw",
    });

    assert.ok(command.includes("--print"));
  });

  it("mounts the clone and never the developer's own checkout", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(5),
      mount: "rw",
    });

    assert.ok(command.includes(`${CLONE}:/repo`));
  });

  it("mounts the clone read-write by default", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(5),
      mount: "rw",
    });

    assert.ok(!command.includes(`${CLONE}:/repo:ro`));
  });

  /**
   * Half the enforcement a reviewer's inability to push relies on — see
   * `Mount` for the other half, the credential `envFor` forwards alongside it.
   */
  it("mounts the clone read-only when asked to review", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "review it",
      spendCeiling: usd(5),
      mount: "ro",
    });

    assert.ok(command.includes(`${CLONE}:/repo:ro`));
  });

  it("forwards the same credential names to the container regardless of mount", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "review it",
      spendCeiling: usd(5),
      mount: "ro",
    });

    assert.ok(command.includes("GH_TOKEN"));
    assert.ok(command.includes("GITHUB_TOKEN"));
  });

  /**
   * The other flag that fails silently, and the one that already has: without
   * it `--print` sends every permission question to a host that is not there —
   * `execFile` is not one — and the CLI denies the lot. A run so refused still
   * exits zero, so nothing downstream can tell it apart from an agent that
   * looked at the ticket and left it alone. The argument list is the only place
   * this is observable without a container and a credential.
   */
  it("grants the agent its permissions, since no host is there to be asked", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(5),
      mount: "rw",
    });

    const mode = command.indexOf("--permission-mode");
    assert.notEqual(
      mode,
      -1,
      "no --permission-mode: every Bash, Write and Edit call would be denied",
    );
    assert.equal(command[mode + 1], "bypassPermissions");
  });

  /**
   * A reviewer needs the same grant. What stops it pushing is the read-only
   * mount and the scoped credential (see `Mount`), not a prompt — and a
   * reviewer denied Bash cannot run `gh` to post its findings either, which
   * would fail the same quiet way.
   */
  it("grants a review its permissions too", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "review it",
      spendCeiling: usd(5),
      mount: "ro",
    });

    assert.ok(command.includes("--permission-mode"));
  });

  /**
   * The third flag that fails quietly, and the one whose failure depends on
   * whose machine it is. Unpinned, the container runs as the image's own user,
   * and everything the agent writes through the bind mount is owned by that
   * uid rather than by whoever started the run — invisible on a host whose
   * developer happens to be uid 1000, and on any other host a clone the
   * developer cannot delete afterwards. The CLI also refuses
   * `bypassPermissions` outright under uid 0, so an image that regressed to
   * root would fail every run before the agent made a single call.
   */
  it("pins the container to the uid and gid that started the run", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(5),
      mount: "rw",
    });

    const pin = command.indexOf("--user");
    assert.notEqual(
      pin,
      -1,
      "no --user: the agent writes as the image's user rather than the developer's",
    );
    assert.equal(
      command[pin + 1],
      `${process.getuid?.()}:${process.getgid?.()}`,
    );
  });

  /**
   * A manager started with `sudo` would pin the container to root and hand the
   * CLI a permission mode it refuses under root — the very failure this pin
   * exists downstream of, arriving as exit 1 rather than as one of docker's own
   * codes, so `dockerNeverRan` would call it an agent that gave up and every
   * ticket that morning would be handed back quoting a flag nobody passed.
   *
   * Refused rather than fixed by falling back to the image's own user: the
   * clone a root manager makes is `mkdtemp`'s 0700 and root's, so uid 1000
   * could not read it either. Nothing can run here, which is what
   * `AgentNeverRan` means.
   */
  it("refuses to build a command at all when the manager itself is root", () => {
    const { getuid, getgid } = process;
    process.getuid = () => 0;
    process.getgid = () => 0;

    try {
      assert.throws(
        () =>
          dockerCommand({
            directory: CLONE,
            prompt: "do the thing",
            spendCeiling: usd(5),
            mount: "rw",
          }),
        AgentNeverRan,
      );
    } finally {
      if (getuid) {
        process.getuid = getuid;
      }
      if (getgid) {
        process.getgid = getgid;
      }
    }
  });

  /**
   * Not every host reports a uid — `process.getuid` is absent on Windows. The
   * image's own non-root user is a workable answer there; refusing to build a
   * command at all would turn a portability gap into a morning of failed runs.
   */
  it("leaves the image's own user in place where the host exposes no uid", () => {
    const { getuid, getgid } = process;
    delete process.getuid;
    delete process.getgid;

    try {
      const command = dockerCommand({
        directory: CLONE,
        prompt: "do the thing",
        spendCeiling: usd(5),
        mount: "rw",
      });

      assert.ok(
        !command.includes("--user"),
        "pinned a user the host never reported",
      );
    } finally {
      // Guarded rather than assigned back unconditionally: on a host that
      // never had them, there is nothing to put back and the types say so.
      if (getuid) {
        process.getuid = getuid;
      }
      if (getgid) {
        process.getgid = getgid;
      }
    }
  });
});

describe("dockerNeverRan", () => {
  /** What `execFile` rejects with when the command exits `code`. */
  function exited(code: number | string): Error {
    return Object.assign(new Error(`Command failed with ${code}`), { code });
  }

  it("counts docker's own exit codes as the agent never having run", () => {
    // 125: the daemon, or the image. 126 and 127: the entrypoint.
    for (const code of [125, 126, 127]) {
      assert.equal(dockerNeverRan(exited(code)), true, `exit ${code}`);
    }
  });

  it("counts docker not being installed as the agent never having run", () => {
    assert.equal(dockerNeverRan(exited("ENOENT")), true);
  });

  it("leaves every other exit to the agent, killed containers included", () => {
    // 1: the agent gave up. 137: killed, say for memory, mid-run.
    for (const code of [1, 2, 137]) {
      assert.equal(dockerNeverRan(exited(code)), false, `exit ${code}`);
    }
  });

  it("does not mistake something thrown without a code for docker", () => {
    assert.equal(dockerNeverRan(new Error("no code")), false);
    assert.equal(dockerNeverRan("a string"), false);
    assert.equal(dockerNeverRan(null), false);
  });
});

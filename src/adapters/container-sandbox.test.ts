import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { withCheckoutLock } from "./checkout-lock.ts";
import {
  AgentNeverRan,
  containerSandbox,
  dockerCommand,
  dockerNeverRan,
  pullRequestHeadFrom,
  pushableRemote,
  readAgentRun,
  readExitedRun,
  type Container,
  type Mount,
} from "./container-sandbox.ts";
import {
  branch,
  checkout,
  commitSha,
  modelName,
  pullRequestUrl,
  remoteUrl,
  repoSlug,
  tokenCount,
  usd,
  type ApplyReviewOutcome,
  type ApplyReviewTicket,
  type Checkout,
  type ReviewOutcome,
  type ReviewTicket,
  type RunOutcome,
  type Ticket,
} from "../ports/index.ts";
import { gate, HANGS, LIMIT_REFUSAL } from "../testing/index.ts";

const run = promisify(execFile);

/** The `kind` variant of `result`, absent if it ended any other way. */
function variant<
  Outcome extends RunOutcome | ReviewOutcome | ApplyReviewOutcome,
  Kind extends Outcome["kind"],
>(result: Outcome, kind: Kind): Extract<Outcome, { kind: Kind }> | undefined {
  return result.kind === kind
    ? (result as Extract<Outcome, { kind: Kind }>)
    : undefined;
}

const TICKET: Ticket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 7,
  title: "Run a ticket in the sandbox",
};

const REVIEW_TICKET: ReviewTicket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 42,
  title: "Review the draft pull request for #7",
  pullRequest: {
    kind: "review",
    url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
  },
};

const BRANCH = "issue-7-run-a-ticket-in-the-sandbox";

/** What the loop would have taken off the budget for one run. */
const CEILING = usd(5);

/**
 * A project checkout with one commit on `main`, which is what the repo host
 * hands the sandbox. Only the git half of the adapter is exercised here; the
 * container half needs docker and a credential, and is injected instead.
 */
async function project(
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<Checkout> {
  const directory = checkout(await mkdtemp(path.join(tmpdir(), "sandbox-")));
  await run("git", [
    "init",
    "--initial-branch=main",
    `--object-format=${objectFormat}`,
    directory,
  ]);
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

/**
 * Agents that, once started, wait to be released before doing what
 * `afterRelease` does — so a test can see how many are in progress at once.
 *
 * `allInProgress` settles once `count` of them are in progress together, and
 * never otherwise: a sandbox that only ever starts one fails the test by its
 * timeout rather than by a guess at how long is long enough.
 */
function heldAgents(
  count: number,
  afterRelease: Container,
): { container: Container; allInProgress: Promise<void>; release: () => void } {
  const started = gate();
  const released = gate();
  let inProgress = 0;

  return {
    container: async (options) => {
      inProgress += 1;
      if (inProgress === count) {
        started.open();
      }
      await released.opened;
      return afterRelease(options);
    },
    allInProgress: started.opened,
    release: released.open,
  };
}

/**
 * Captured from the real CLI, signed in: `claude --print "say hi" --model
 * this-model-does-not-exist-xyz --output-format json` exits 1, printing this
 * envelope (trimmed to the fields the adapter or a reader cares about) to
 * stdout and the line below to stderr — see `MODEL_REFUSAL` in
 * container-sandbox.ts.
 */
const MODEL_REFUSAL_WORDS =
  "There's an issue with the selected model (this-model-does-not-exist-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.";
const MODEL_REFUSAL_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 404,
  terminal_reason: "api_error",
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
  permission_denials: [],
  result: MODEL_REFUSAL_WORDS,
});
const MODEL_REFUSAL_STDERR =
  '[claude-code:unrecognized_model] {"model":"this-model-does-not-exist-xyz","query_source":"sdk"}\n';

/** What `execFile` rejects with when `docker run` passes on the refusal's exit 1. */
const MODEL_REFUSAL_EXIT = Object.assign(
  new Error("Command failed: docker run"),
  { code: 1, stdout: MODEL_REFUSAL_STDOUT, stderr: MODEL_REFUSAL_STDERR },
);

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

  it("asks docker for no model when the request names none", async () => {
    const directory = await project();
    let seen: string | undefined = "unset";
    const sandbox = containerSandbox(async ({ model }) => {
      seen = model;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(seen, undefined);
  });

  it("passes the request's model to the agent CLI as a single value", async () => {
    const directory = await project();
    let seen: string | undefined;
    const sandbox = containerSandbox(async ({ model }) => {
      seen = model;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.run({
      ticket: TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("opus"),
    });

    assert.equal(seen, "opus");
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

  it("returns the commits of a repository whose object ids are SHA-256", async () => {
    const directory = await project("sha256");
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(result.commits.length, 1);
    assert.equal(result.commits[0]?.length, 64);
    assert.equal(await headOf(directory, BRANCH), result.commits.at(-1));
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

    assert.equal(result.kind, "finished");
    assert.equal(variant(result, "finished")?.output, "implemented the thing");
    assert.equal(result.tokensUsed, tokenCount(42_000));
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

    assert.equal(result.kind, "gave-up");
    assert.match(variant(result, "gave-up")?.reason ?? "", /gave up/);
    assert.match(variant(result, "gave-up")?.output ?? "", /gave up/);
    assert.equal(result.commits.length, 1);
    assert.deepEqual(await branchesIn(directory), [BRANCH, "main"]);
  });

  /**
   * A limit refusal exits non-zero, spends nothing, and would otherwise read
   * exactly like an agent that gave up.
   */
  it("reports a limit refusal apart from a failed agent", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      output: LIMIT_REFUSAL,
      tokensUsed: tokenCount(0),
      failure: "Command failed: docker run",
    }));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(result.kind, "limit-refused");
    assert.equal(variant(result, "limit-refused")?.words, LIMIT_REFUSAL);
  });

  it("reports a limit refusal even when the CLI exits zero", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      output: LIMIT_REFUSAL,
      tokensUsed: tokenCount(0),
    }));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(variant(result, "limit-refused")?.words, LIMIT_REFUSAL);
  });

  for (const refusal of [
    "You’ve hit your session limit · resets 1pm (UTC)",
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
    "You've hit your weekly limit · resets Mon 9am (Asia/Jerusalem)",
  ]) {
    it(`reads "${refusal}" as a limit refusal`, async () => {
      const directory = await project();
      const sandbox = containerSandbox(async () => ({
        output: refusal,
        tokensUsed: tokenCount(0),
        failure: "Command failed: docker run",
      }));

      const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

      assert.equal(variant(result, "limit-refused")?.words, refusal);
    });
  }

  it("reads a limit refusal out of the CLI's JSON envelope", async () => {
    const directory = await project();
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: LIMIT_REFUSAL,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const sandbox = containerSandbox(async () => ({
      ...readAgentRun(stdout),
      failure: "Command failed: docker run",
    }));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(variant(result, "limit-refused")?.words, LIMIT_REFUSAL);
  });

  it("reads a limit refusal the CLI printed as plain text rather than an envelope", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      ...readAgentRun(`${LIMIT_REFUSAL}\n`),
      failure: "Command failed: docker run",
    }));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(variant(result, "limit-refused")?.words, LIMIT_REFUSAL);
  });

  it("does not mistake a failed agent that quoted the limit for one refused by it", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      output: `The tests would not go green. The CLI says, on a spent limit:\n${LIMIT_REFUSAL}`,
      tokensUsed: tokenCount(1_000),
      failure: "Command failed: docker run",
    }));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(result.kind, "gave-up");
    assert.equal(variant(result, "gave-up")?.reason, "Command failed: docker run");
  });

  it("does not mistake a finished agent that mentions the limit for one refused by it", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      output: `Implemented the stand-down. The CLI says:\n${LIMIT_REFUSAL}`,
      tokensUsed: tokenCount(1_000),
    }));

    const result = await sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });

    assert.equal(result.kind, "finished");
  });

  it("reports a model refusal apart from an agent that gave up", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () =>
      readExitedRun(MODEL_REFUSAL_EXIT),
    );

    const result = await sandbox.run({
      ticket: TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("this-model-does-not-exist-xyz"),
    });

    assert.equal(result.kind, "model-refused");
    assert.deepEqual(variant(result, "model-refused")?.refusal, {
      model: modelName("this-model-does-not-exist-xyz"),
      words: MODEL_REFUSAL_WORDS,
    });
  });

  it("does not read a model refusal when the request named no model", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () =>
      readExitedRun(MODEL_REFUSAL_EXIT),
    );

    const result = await sandbox.run({
      ticket: TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.kind, "gave-up");
    assert.equal(variant(result, "gave-up")?.reason, "Command failed: docker run");
  });

  /**
   * Not merely a runtime check: `Sandbox.run` is overloaded so that a call
   * naming no model resolves to the overload whose `RunOutcome` excludes
   * `"model-refused"` outright — there is no such case left to read, so
   * `run.refusal` does not typecheck at all once `model` is confirmed absent.
   */
  it("excludes the model-refused variant from its type for a run given no model", async () => {
    const directory = await project();
    const sandbox = containerSandbox(agentCommitting([]));

    const result = await sandbox.run({
      ticket: TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    // @ts-expect-error a run given no model can never come back model-refused
    if (result.kind === "model-refused") {
      assert.fail("unreachable: excluded from the overload's own return type");
    }
  });

  it("does not mistake a finished agent that quotes the model refusal tag for one refused", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () =>
      readAgentRun(
        JSON.stringify({
          result: `Matched the CLI's line:\n${MODEL_REFUSAL_STDERR}`,
        }),
      ),
    );

    const result = await sandbox.run({
      ticket: TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("opus"),
    });

    assert.equal(result.kind, "finished");
  });

  it("does not mistake an agent that gave up quoting the model refusal tag for one refused", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      ...readAgentRun(
        JSON.stringify({
          result: `The tests would not go green on:\n${MODEL_REFUSAL_STDERR}`,
        }),
      ),
      failure: "Command failed: docker run",
    }));

    const result = await sandbox.run({
      ticket: TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("opus"),
    });

    assert.equal(result.kind, "gave-up");
    assert.equal(variant(result, "gave-up")?.reason, "Command failed: docker run");
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

  it("runs agents side by side on one checkout", HANGS, async () => {
    const directory = await project();
    const held = heldAgents(2, agentCommitting(["one.txt"]));
    const sandbox = containerSandbox(held.container);

    const runs = Promise.all([
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
      sandbox.run({
        ticket: { ...TICKET, number: 8, title: "Another" },
        checkout: directory,
        spendCeiling: CEILING,
      }),
    ]);
    // Never settles if the second agent waits for the first to finish.
    await held.allInProgress;
    held.release();
    await runs;
  });

  /**
   * A branch reaches the checkout only when its run is fetched back, so a
   * second run choosing a name while the first is still in progress sees no
   * branch there yet — and must not be handed the same name.
   */
  it("gives runs of one ticket in progress at once a branch each", HANGS, async () => {
    const directory = await project();
    const held = heldAgents(2, agentCommitting(["one.txt"]));
    const sandbox = containerSandbox(held.container);

    const runs = Promise.all([
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
    ]);
    await held.allInProgress;
    held.release();
    const results = await runs;

    assert.deepEqual(results.map((result) => result.branch).sort(), [
      BRANCH,
      `${BRANCH}-2`,
    ]);
    assert.deepEqual(await branchesIn(directory), [
      BRANCH,
      `${BRANCH}-2`,
      "main",
    ]);
    for (const result of results) {
      assert.equal(await headOf(directory, result.branch), result.commits.at(-1));
    }
  });

  it("waits for the checkout lock before cloning, and only on its own checkout", async () => {
    const directory = await project();
    const elsewhere = await project();
    const cloned: string[] = [];
    const sandbox = containerSandbox(async (options) => {
      cloned.push(options.directory);
      return { output: "", tokensUsed: tokenCount(0) };
    });
    const lock = gate();
    const holding = withCheckoutLock(directory, () => lock.opened);

    const waiting = sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING });
    await sandbox.run({ ticket: TICKET, checkout: elsewhere, spendCeiling: CEILING });

    assert.equal(cloned.length, 1, "the run on the locked checkout cloned it anyway");
    lock.open();
    await holding;
    await waiting;
    assert.equal(cloned.length, 2);
  });

  /**
   * The agent itself takes the lock before it hands back, so the lock is held
   * before the run can reach its fetch. A whole run on another checkout —
   * clone, agent, fetch back — then has to finish first: far more git than the
   * locked run has left before its fetch, so a fetch that ignored the lock
   * would have landed by then.
   */
  it("waits for the checkout lock before fetching its branch back, and only on its own checkout", HANGS, async () => {
    const directory = await project();
    const elsewhere = await project();
    const lock = gate();
    let holding: Promise<void> | undefined;
    const commit = agentCommitting(["one.txt"]);
    const sandbox = containerSandbox(async (options) => {
      const agent = await commit(options);
      holding = withCheckoutLock(directory, () => lock.opened);
      return agent;
    });
    let settled = false;

    const running = sandbox
      .run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING })
      .finally(() => {
        settled = true;
      });
    const other = await containerSandbox(agentCommitting(["two.txt"])).run({
      ticket: TICKET,
      checkout: elsewhere,
      spendCeiling: CEILING,
    });

    assert.deepEqual(await branchesIn(elsewhere), [other.branch, "main"]);
    assert.equal(settled, false, "the run finished while its checkout was locked");
    assert.deepEqual(await branchesIn(directory), ["main"]);
    lock.open();
    await holding;
    const result = await running;
    assert.deepEqual(await branchesIn(directory), [result.branch, "main"]);
  });

  /**
   * Fails a git step taken under the lock: every name the ticket may have is
   * already a branch, so choosing one throws while the lock is held.
   */
  it("leaves the checkout free for the next run when a step under the lock fails", HANGS, async () => {
    const directory = await project();
    const names = [BRANCH, ...Array.from({ length: 9 }, (_, i) => `${BRANCH}-${i + 2}`)];
    for (const name of names) {
      await run("git", ["-C", directory, "branch", name]);
    }
    const sandbox = containerSandbox(agentCommitting(["one.txt"]));

    await assert.rejects(
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
      /already has 10 branches/,
    );
    await run("git", ["-C", directory, "branch", "--delete", ...names]);

    const result = await sandbox.run({
      ticket: TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.branch, BRANCH);
    assert.deepEqual(await branchesIn(directory), [BRANCH, "main"]);
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

  it("passes the review's model to the agent CLI the same way a run does, and stays read-only", async () => {
    const directory = await project();
    let seenModel: string | undefined;
    let seenMount: Mount | undefined;
    const sandbox = containerSandbox(async ({ model, mount }) => {
      seenModel = model;
      seenMount = mount;
      return { output: "", tokensUsed: tokenCount(0) };
    });

    await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("opus"),
    });

    assert.equal(seenModel, "opus");
    assert.equal(seenMount, "ro");
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

    assert.match(
      asked,
      new RegExp(REVIEW_TICKET.pullRequest.url.replace(/\//g, "\\/")),
    );
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
   * A `--print` run has nobody on the other end. A reviewer that finishes,
   * then asks "shall I submit this?", posts nothing — and the loop hands the
   * ticket back with the findings surviving only in its comment.
   */
  it("says the run is unattended, so the review is submitted without asking", async () => {
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

    assert.match(asked, /unattended/);
    assert.match(asked, /without asking/);
  });

  /**
   * The reviewer posts with the developer's own `GH_TOKEN`, so an
   * apply-review workflow watching for that comment cannot tell the
   * reviewer's from the developer's by author. Acting on the review is the
   * developer's call, not the reviewer's — and no other line of the prompt
   * may say otherwise, so `/apply-review` appears in it exactly once.
   */
  it("forbids the reviewer from ever posting /apply-review", async () => {
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

    assert.match(asked, /developer's own GitHub credential, so nothing marks a comment of yours\s+apart from one the developer wrote\./);
    assert.match(asked, /Never post a comment whose whole body is\s+`\/apply-review`\s+— acting on this review is the developer's call, not yours\./);
    assert.equal(asked.match(/\/apply-review/g)?.length, 1);
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

    assert.equal(result.kind, "finished");
    assert.equal(variant(result, "finished")?.output, "posted findings");
    assert.equal(result.tokensUsed, tokenCount(9_000));
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

    assert.equal(result.kind, "gave-up");
    assert.match(variant(result, "gave-up")?.reason ?? "", /gave up/);
    assert.match(variant(result, "gave-up")?.output ?? "", /gave up/);
  });

  it("reports a limit refusal apart from a failed reviewer", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () => ({
      output: LIMIT_REFUSAL,
      tokensUsed: tokenCount(0),
      failure: "Command failed: docker run",
    }));

    const result = await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.kind, "limit-refused");
    assert.equal(variant(result, "limit-refused")?.words, LIMIT_REFUSAL);
  });

  it("reports a model refusal apart from a reviewer that gave up, naming the model and the CLI's words", async () => {
    const directory = await project();
    const sandbox = containerSandbox(async () =>
      readExitedRun(MODEL_REFUSAL_EXIT),
    );

    const result = await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("this-model-does-not-exist-xyz"),
    });

    assert.equal(result.kind, "model-refused");
    assert.deepEqual(variant(result, "model-refused")?.refusal, {
      model: modelName("this-model-does-not-exist-xyz"),
      words: MODEL_REFUSAL_WORDS,
    });
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

  it("reviews side by side with an implementation run on the same checkout", HANGS, async () => {
    const directory = await project();
    const held = heldAgents(2, async () => ({
      output: "",
      tokensUsed: tokenCount(0),
    }));
    const sandbox = containerSandbox(held.container);

    const both = Promise.all([
      sandbox.run({ ticket: TICKET, checkout: directory, spendCeiling: CEILING }),
      sandbox.review({
        ticket: REVIEW_TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
    ]);
    // Never settles if the review waits for the run to finish.
    await held.allInProgress;
    held.release();
    await both;
  });
});

const APPLY_REVIEW_TICKET: ApplyReviewTicket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 43,
  title: "Apply the review on the draft pull request for #7",
  pullRequest: {
    kind: "apply-review",
    url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
  },
};

/**
 * A project checkout whose `origin` is a bare repository standing in for
 * GitHub, holding the pull request's head branch one commit ahead of what the
 * checkout has — so a clone on the right branch can only have come from the
 * repo host, never from the checkout.
 */
async function hostedProject(): Promise<{
  directory: Checkout;
  hosted: string;
  headCommit: string;
}> {
  const directory = await project();
  const hosted = await mkdtemp(path.join(tmpdir(), "sandbox-hosted-"));
  await run("git", ["init", "--bare", "--initial-branch=main", hosted]);
  await run("git", ["-C", directory, "remote", "add", "origin", hosted]);
  await run("git", ["-C", directory, "push", "--quiet", "origin", "main"]);

  const elsewhere = await mkdtemp(path.join(tmpdir(), "sandbox-elsewhere-"));
  await run("git", ["clone", "--quiet", hosted, elsewhere]);
  await identify(elsewhere);
  await run("git", ["-C", elsewhere, "switch", "--create", BRANCH]);
  await writeFile(path.join(elsewhere, "work.md"), "work\n");
  await run("git", ["-C", elsewhere, "add", "."]);
  await run("git", ["-C", elsewhere, "commit", "--message", "Work"]);
  await run("git", ["-C", elsewhere, "push", "--quiet", "origin", BRANCH]);

  return { directory, hosted, headCommit: await headOf(elsewhere) };
}

/** The head lookup a hosted project's pull request answers with. */
const headIsBranch = async () => branch(BRANCH);

const MOVED_HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("containerSandbox.applyReview", () => {
  it("mounts a clone of its own, read-write, on the pull request's head branch as the repo host has it", async () => {
    const { directory, headCommit } = await hostedProject();
    const seen: { mounted: string; mount: Mount; on: string; at: string }[] = [];
    const sandbox = containerSandbox(async ({ directory: mounted, mount }) => {
      seen.push({
        mounted,
        mount,
        on: (await run("git", ["-C", mounted, "branch", "--show-current"])).stdout.trim(),
        at: await headOf(mounted),
      });
      return { output: "", tokensUsed: tokenCount(0) };
    }, headIsBranch);

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(seen.length, 1);
    assert.notEqual(seen[0]?.mounted, directory);
    assert.equal(seen[0]?.mount, "rw");
    assert.equal(seen[0]?.on, BRANCH);
    assert.equal(seen[0]?.at, headCommit);
  });

  it("looks the head branch up from the ticket's own pull request", async () => {
    const { directory } = await hostedProject();
    const asked: string[] = [];
    const sandbox = containerSandbox(
      async () => ({ output: "", tokensUsed: tokenCount(0) }),
      async (pullRequest) => {
        asked.push(pullRequest);
        return branch(BRANCH);
      },
    );

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.deepEqual(asked, [APPLY_REVIEW_TICKET.pullRequest.url]);
  });

  /**
   * The agent pushes from inside the container, where the checkout's path
   * means nothing: the clone's own remote has to be the repo host, with the branch
   * tracking it, or a plain `git push` goes nowhere.
   */
  it("leaves the branch tracking the repo host, so the agent's plain push lands on the pull request", async () => {
    const { directory, hosted } = await hostedProject();
    let pushed = "";
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
      await identify(mounted);
      await writeFile(path.join(mounted, "applied.md"), "applied\n");
      await run("git", ["-C", mounted, "add", "."]);
      await run("git", ["-C", mounted, "commit", "--message", "Apply"]);
      await run("git", ["-C", mounted, "push", "--quiet"]);
      pushed = await headOf(mounted);
      return { output: "", tokensUsed: tokenCount(0) };
    }, headIsBranch);

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(await headOf(hosted, BRANCH), pushed);
  });

  it("fetches no branch back and creates none in the checkout, whatever the agent does", async () => {
    const { directory } = await hostedProject();
    const before = await headOf(directory);
    const sandbox = containerSandbox(agentCommitting(["applied.md"]), headIsBranch);

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.deepEqual(await branchesIn(directory), ["main"]);
    assert.equal(await headOf(directory), before);
  });

  it("names the pull request and invokes the apply-pr-review skill on it", async () => {
    const { directory } = await hostedProject();
    let asked = "";
    const sandbox = containerSandbox(async ({ prompt }) => {
      asked = prompt;
      return { output: "", tokensUsed: tokenCount(0) };
    }, headIsBranch);

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.ok(
      asked.includes(`/apply-pr-review ${APPLY_REVIEW_TICKET.pullRequest.url}`),
      asked,
    );
    assert.match(asked, /unattended/);
  });

  it("passes the model to the agent CLI", async () => {
    const { directory } = await hostedProject();
    let seen: string | undefined;
    const sandbox = containerSandbox(async ({ model }) => {
      seen = model;
      return { output: "", tokensUsed: tokenCount(0) };
    }, headIsBranch);

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("sonnet"),
    });

    assert.equal(seen, "sonnet");
  });

  it("returns the agent's own output and what the run cost", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(async () => ({
      output: "answered 3 threads",
      tokensUsed: tokenCount(9_000),
    }), headIsBranch);

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.deepEqual(result, {
      kind: "finished",
      output: "answered 3 threads",
      tokensUsed: tokenCount(9_000),
    });
  });

  it("reports a failed agent rather than throwing", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(async () => {
      throw new Error("the agent gave up");
    }, headIsBranch);

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.kind, "gave-up");
    assert.match(variant(result, "gave-up")?.reason ?? "", /gave up/);
    assert.equal(variant(result, "gave-up")?.movedHead, undefined);
  });

  it("reports a push rejected because the branch moved as gave-up, carrying the moved head", async () => {
    const { directory } = await hostedProject();
    const report = [
      "Push rejected: the branch moved under me.",
      `Branch moved: ${MOVED_HEAD}`,
    ].join("\n");
    const sandbox = containerSandbox(async () => ({
      output: report,
      tokensUsed: tokenCount(500),
    }), headIsBranch);

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.kind, "gave-up");
    const gaveUp = variant(result, "gave-up");
    assert.equal(gaveUp?.movedHead, commitSha(MOVED_HEAD));
    assert.match(gaveUp?.reason ?? "", new RegExp(MOVED_HEAD));
    assert.equal(gaveUp?.output, report);
    assert.equal(result.tokensUsed, tokenCount(500));
  });

  it("reads a moved head the agent followed with more words on the same line", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(async () => ({
      output: `Branch moved: ${MOVED_HEAD} (was def5678)`,
      tokensUsed: tokenCount(0),
    }), headIsBranch);

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(variant(result, "gave-up")?.movedHead, commitSha(MOVED_HEAD));
  });

  it("gives up without a moved head when the agent named it by an abbreviated hash", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(async () => ({
      output: "Branch moved: abc1234",
      tokensUsed: tokenCount(0),
    }), headIsBranch);

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.kind, "gave-up");
    assert.equal(variant(result, "gave-up")?.movedHead, undefined);
  });

  it("lands on the repo host's head even when the clone already has a branch of that name", async () => {
    const { directory, headCommit } = await hostedProject();
    // The checkout sits on a stale copy of the head branch, which the clone inherits.
    await run("git", ["-C", directory, "switch", "--quiet", "--create", BRANCH]);
    let at = "";
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
      at = await headOf(mounted);
      return { output: "", tokensUsed: tokenCount(0) };
    }, headIsBranch);

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(at, headCommit);
  });

  it("reads no moved head from a line that names no commit", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(async () => ({
      output: "Branch moved: somewhere",
      tokensUsed: tokenCount(0),
    }), headIsBranch);

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(result.kind, "finished");
  });

  it("reports a limit refusal as a review run does", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(async () => ({
      output: LIMIT_REFUSAL,
      tokensUsed: tokenCount(0),
      failure: "Command failed: docker run",
    }), headIsBranch);

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.deepEqual(result, {
      kind: "limit-refused",
      words: LIMIT_REFUSAL,
      tokensUsed: tokenCount(0),
    });
  });

  it("reports a model refusal as a review run does, naming the model and the CLI's words", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(
      async () => readExitedRun(MODEL_REFUSAL_EXIT),
      headIsBranch,
    );

    const result = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
      model: modelName("this-model-does-not-exist-xyz"),
    });

    assert.deepEqual(result, {
      kind: "model-refused",
      refusal: {
        model: modelName("this-model-does-not-exist-xyz"),
        words: MODEL_REFUSAL_WORDS,
      },
      tokensUsed: tokenCount(0),
    });
  });

  it("rejects, starting no agent, when the head branch cannot be looked up", async () => {
    const { directory } = await hostedProject();
    let started = false;
    const sandbox = containerSandbox(
      async () => {
        started = true;
        return { output: "", tokensUsed: tokenCount(0) };
      },
      async () => {
        throw new Error("gh: no pull request found");
      },
    );

    await assert.rejects(
      sandbox.applyReview({
        ticket: APPLY_REVIEW_TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
      /no pull request found/,
    );
    assert.equal(started, false);
  });

  it("rejects, starting no agent, when the repo host has no such branch", async () => {
    const { directory } = await hostedProject();
    let started = false;
    const sandbox = containerSandbox(
      async () => {
        started = true;
        return { output: "", tokensUsed: tokenCount(0) };
      },
      async () => branch("no-such-branch"),
    );

    await assert.rejects(
      sandbox.applyReview({
        ticket: APPLY_REVIEW_TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
    );
    assert.equal(started, false);
  });

  it("rejects, starting no agent, when the checkout's origin is no address a clone can push to", async () => {
    const { directory } = await hostedProject();
    await run("git", ["-C", directory, "remote", "set-url", "origin", "../pilot"]);
    let started = false;
    const sandbox = containerSandbox(async () => {
      started = true;
      return { output: "", tokensUsed: tokenCount(0) };
    }, headIsBranch);

    await assert.rejects(
      sandbox.applyReview({
        ticket: APPLY_REVIEW_TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
      /not an address a clone can push to/,
    );
    assert.equal(started, false);
  });

  it("rejects as an infrastructure failure when the agent never ran", async () => {
    const { directory } = await hostedProject();
    const sandbox = containerSandbox(async () => {
      throw new AgentNeverRan("docker is not running");
    }, headIsBranch);

    await assert.rejects(
      sandbox.applyReview({
        ticket: APPLY_REVIEW_TICKET,
        checkout: directory,
        spendCeiling: CEILING,
      }),
      AgentNeverRan,
    );
  });

  it("takes the clone away once the run ends", async () => {
    const { directory } = await hostedProject();
    let clone = "";
    const sandbox = containerSandbox(async ({ directory: mounted }) => {
      clone = mounted;
      return { output: "", tokensUsed: tokenCount(0) };
    }, headIsBranch);

    await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: directory,
      spendCeiling: CEILING,
    });

    assert.equal(await exists(clone), false);
  });
});

describe("pushableRemote", () => {
  for (const [ssh, https] of [
    ["git@github.com:nadav-alon/pilot.git", "https://github.com/nadav-alon/pilot.git"],
    ["git@github.com:nadav-alon/pilot", "https://github.com/nadav-alon/pilot.git"],
    ["ssh://git@github.com/nadav-alon/pilot.git", "https://github.com/nadav-alon/pilot.git"],
  ] as const) {
    it(`reaches ${ssh} over HTTPS, which the container's token can push to`, () => {
      assert.equal(pushableRemote(remoteUrl(ssh)), https);
    });
  }

  it("leaves an HTTPS remote and a local path as they are", () => {
    assert.equal(
      pushableRemote(remoteUrl("https://github.com/nadav-alon/pilot.git")),
      "https://github.com/nadav-alon/pilot.git",
    );
    assert.equal(pushableRemote(remoteUrl("/srv/git/pilot")), "/srv/git/pilot");
  });
});

describe("pullRequestHeadFrom", () => {
  const url = APPLY_REVIEW_TICKET.pullRequest.url;

  it("reads the head branch of a pull request from its own repo", () => {
    const answer = JSON.stringify({ headRefName: BRANCH, isCrossRepository: false });

    assert.equal(pullRequestHeadFrom(answer, url), branch(BRANCH));
  });

  it("refuses a pull request opened from a fork, whose head the checkout's remote does not have", () => {
    const answer = JSON.stringify({ headRefName: BRANCH, isCrossRepository: true });

    assert.throws(() => pullRequestHeadFrom(answer, url), /its own repo/);
  });

  it("refuses an answer that does not say whether the pull request is from a fork", () => {
    const answer = JSON.stringify({ headRefName: BRANCH });

    assert.throws(() => pullRequestHeadFrom(answer, url), /its own repo/);
  });

  for (const headRefName of [undefined, 7, "not a branch.."]) {
    it(`refuses a head branch of ${JSON.stringify(headRefName)}`, () => {
      const answer = JSON.stringify({ headRefName, isCrossRepository: false });

      assert.throws(() => pullRequestHeadFrom(answer, url), /no usable head branch/);
    });
  }
});

describe("readAgentRun", () => {
  it("reads a model refusal off stderr, in the words of the CLI's result", () => {
    const agent = readAgentRun(MODEL_REFUSAL_STDOUT, MODEL_REFUSAL_STDERR);

    assert.equal(agent.modelRefused, MODEL_REFUSAL_WORDS);
  });

  it("quotes the model refusal tag itself when there is no result to quote", () => {
    const agent = readAgentRun("", MODEL_REFUSAL_STDERR);

    assert.equal(agent.modelRefused, MODEL_REFUSAL_STDERR.trim());
  });

  it("reads no model refusal from the agent's own words", () => {
    const agent = readAgentRun(
      JSON.stringify({ result: MODEL_REFUSAL_STDERR }),
    );

    assert.equal(agent.modelRefused, undefined);
  });
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

  it("passes no model argument when none is asked for", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(5),
      mount: "rw",
    });

    assert.ok(!command.includes("--model"));
  });

  it("passes the model to the agent CLI as one argument, whatever it contains", () => {
    const name = "opus;rm$(whoami)'x'|&";
    const command = dockerCommand({
      directory: CLONE,
      prompt: "do the thing",
      spendCeiling: usd(5),
      mount: "rw",
      model: modelName(name),
    });

    const flag = command.indexOf("--model");
    assert.ok(flag > command.indexOf("--print"), "--model must reach the CLI, not docker");
    assert.equal(command[flag + 1], name);
    assert.equal(command.filter((argument) => argument.includes("opus")).length, 1);
  });

  it("passes a review's model the same way, and still mounts read-only", () => {
    const command = dockerCommand({
      directory: CLONE,
      prompt: "review it",
      spendCeiling: usd(5),
      mount: "ro",
      model: modelName("opus"),
    });

    assert.equal(command[command.indexOf("--model") + 1], "opus");
    assert.ok(command.includes(`${CLONE}:/repo:ro`));
  });

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

  it("leaves the CLI's refusal of a model to the agent", () => {
    assert.equal(dockerNeverRan(MODEL_REFUSAL_EXIT), false);
  });

  it("does not mistake something thrown without a code for docker", () => {
    assert.equal(dockerNeverRan(new Error("no code")), false);
    assert.equal(dockerNeverRan("a string"), false);
    assert.equal(dockerNeverRan(null), false);
  });
});

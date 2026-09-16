import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";

import { withCheckoutLock } from "./checkout-lock.ts";
import { githubRepoHost } from "./github-repo-host.ts";
import {
  APPLY_REVIEW_MARKER,
  MergeabilityUnknown,
  branch as toBranch,
  checkout as toCheckout,
  pullRequestUrl,
  repoSlug,
  type Checkout,
  type Ticket,
} from "../ports/index.ts";
import { callWith, gate, HANGS, recordingGh, valueOf } from "../testing/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");

const run = promisify(execFile);

/**
 * A checkout with a bare repo behind it, so pushing is a real push. Only the
 * git half of the adapter is exercised here; everything that reaches GitHub
 * needs a credential and a network, and is left to the developer's own run.
 */
async function checkout(remote = "nadav-alon/pilot"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-host-"));
  // Named as the remote it stands for, so the bare repo's path is what the
  // adapter compares the slug against.
  const origin = path.join(root, "origin", `${remote}.git`);
  const working = path.join(root, "location", "nadav-alon", "pilot");

  await mkdir(path.dirname(origin), { recursive: true });
  await run("git", ["init", "--bare", "--initial-branch=main", origin]);
  await run("git", ["clone", origin, working]);
  await run("git", ["-C", working, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", working, "config", "user.name", "Test"]);
  return working;
}

/** The managed location a `checkout()` sits in. */
function locationOf(directory: string): string {
  return path.resolve(directory, "..", "..");
}

/** What `revision` actually contains, as opposed to what is merely staged. */
async function filesIn(directory: string, revision: string): Promise<string[]> {
  const { stdout } = await run("git", [
    "-C",
    directory,
    "ls-tree",
    "-r",
    "--name-only",
    revision,
  ]);
  return stdout.split("\n").filter((line) => line !== "");
}

async function committedFiles(directory: string): Promise<string[]> {
  return filesIn(directory, "HEAD");
}

async function pushedFiles(
  directory: string,
  branch = "origin/main",
): Promise<string[]> {
  return filesIn(directory, branch);
}

/**
 * Proposing against a bare repo on disk. The push is real; opening the pull
 * request is not, because `gh` cannot resolve a local path to a repository —
 * so every case here comes back as `pushed`, which is exactly the outcome the
 * git half is responsible for getting right.
 */
describe("proposing a scaffold to a project that predates the manager", () => {
  const propose = (directory: string, paths: string[]) =>
    githubRepoHost().commitAndPropose(
      directory,
      "Install the agent harness",
      "body",
      paths,
      "harness",
    );

  /** A checkout with history behind it, which is what "predates" means. */
  async function existing(): Promise<string> {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);
    return directory;
  }

  it("commits to its own branch, leaving the one they were on untouched", async () => {
    const directory = await existing();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    const proposal = await propose(directory, ["AGENTS.md"]);

    assert.equal(proposal.kind, "pushed");
    assert.deepEqual(await pushedFiles(directory, "origin/harness"), [
      "AGENTS.md",
      "seed.md",
    ]);
    assert.deepEqual(await pushedFiles(directory), ["seed.md"]);
  });

  it("puts the developer back on the branch it found them on", async () => {
    const directory = await existing();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await propose(directory, ["AGENTS.md"]);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "branch",
      "--show-current",
    ]);
    assert.equal(stdout.trim(), "main");
  });

  it("puts them back even when the repo had no commits to go back to", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await propose(directory, ["AGENTS.md"]);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "branch",
      "--show-current",
    ]);
    assert.equal(stdout.trim(), "main");
  });

  it("leaves work the developer already had in the checkout uncommitted", async () => {
    const directory = await existing();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");
    await writeFile(path.join(directory, "half-finished.ts"), "// mine\n");
    await run("git", ["-C", directory, "add", "half-finished.ts"]);

    await propose(directory, ["AGENTS.md"]);

    assert.deepEqual(await pushedFiles(directory, "origin/harness"), [
      "AGENTS.md",
      "seed.md",
    ]);
    assert.equal(
      await readFile(path.join(directory, "half-finished.ts"), "utf8"),
      "// mine\n",
    );
  });

  it("proposes nothing when the checkout already has the scaffold", async () => {
    const directory = await existing();

    const proposal = await propose(directory, ["seed.md"]);

    assert.deepEqual(proposal, { kind: "unchanged" });
  });

  it("names the branch it pushed when no pull request could be opened", async () => {
    const directory = await existing();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    const proposal = await propose(directory, ["AGENTS.md"]);

    assert.equal(proposal.kind === "pushed" && proposal.branch, "harness");
    assert.ok(proposal.kind === "pushed" && proposal.failure !== "");
  });
});

describe("publishing a scaffold", () => {
  it("commits and pushes the paths it was given", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    assert.deepEqual(await committedFiles(directory), ["AGENTS.md"]);
    assert.deepEqual(await pushedFiles(directory), ["AGENTS.md"]);
  });

  it("leaves work the developer already had in the checkout uncommitted", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");
    await writeFile(path.join(directory, "half-finished.ts"), "// mine\n");
    await run("git", ["-C", directory, "add", "half-finished.ts"]);

    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    assert.deepEqual(await committedFiles(directory), ["AGENTS.md"]);
    const { stdout } = await run("git", [
      "-C",
      directory,
      "status",
      "--porcelain",
      "half-finished.ts",
    ]);
    assert.match(stdout, /half-finished\.ts/);
  });

  it("commits nothing when the scaffold is already what is there", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");
    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    await githubRepoHost().commitAndPush(directory, "Install again", [
      "AGENTS.md",
    ]);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "log",
      "--format=%s",
    ]);
    assert.deepEqual(stdout.trim().split("\n"), ["Install"]);
  });
});

describe("publishing to a checkout the developer already had", () => {
  it("pushes to the branch it is on without re-pointing its upstream", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);
    await run("git", ["-C", directory, "checkout", "-b", "feature/x"]);
    await run("git", ["-C", directory, "push", "--set-upstream", "origin", "feature/x"]);
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    assert.equal(stdout.trim(), "origin/feature/x");
    assert.deepEqual(await pushedFiles(directory, "origin/feature/x"), [
      "AGENTS.md",
      "seed.md",
    ]);
  });

  it("refuses a detached HEAD before committing anything to it", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);
    await run("git", ["-C", directory, "checkout", "--detach"]);
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await assert.rejects(
      githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]),
      /not on a branch/,
    );
    assert.deepEqual(await committedFiles(directory), ["seed.md"]);
  });
});

describe("finding the checkout", () => {
  it("reuses a clone of this project already in the managed location", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "mine.txt"), "kept\n");

    const found = await githubRepoHost(locationOf(directory)).clone(PILOT);

    assert.equal(found, directory);
    assert.equal(await readFile(path.join(found, "mine.txt"), "utf8"), "kept\n");
  });

  /**
   * A commit landing on the remote from somewhere other than `directory` — a
   * pull request merged on GitHub, as far as the managed clone can tell.
   */
  async function landedElsewhere(directory: string, file: string): Promise<void> {
    const { stdout: origin } = await run("git", [
      "-C",
      directory,
      "remote",
      "get-url",
      "origin",
    ]);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "repo-host-elsewhere-"));
    await run("git", ["clone", origin.trim(), elsewhere]);
    await run("git", ["-C", elsewhere, "config", "user.email", "test@example.com"]);
    await run("git", ["-C", elsewhere, "config", "user.name", "Test"]);
    await writeFile(path.join(elsewhere, file), `${file}\n`);
    await run("git", ["-C", elsewhere, "add", file]);
    await run("git", ["-C", elsewhere, "commit", "--message", `Add ${file}`]);
    await run("git", ["-C", elsewhere, "push", "origin", "main"]);
  }

  /** A clone with history, tracking `origin/main`, as the loop's own clone is. */
  async function seeded(): Promise<string> {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);
    return directory;
  }

  it("brings a reused clone up to what its remote has", async () => {
    const directory = await seeded();
    await landedElsewhere(directory, "merged.md");

    const found = await githubRepoHost(locationOf(directory)).clone(PILOT);

    assert.deepEqual(await committedFiles(found), ["merged.md", "seed.md"]);
  });

  it("carries the developer's uncommitted work across the catch-up", async () => {
    const directory = await seeded();
    await landedElsewhere(directory, "merged.md");
    await writeFile(path.join(directory, "seed.md"), "mine\n");

    const found = await githubRepoHost(locationOf(directory)).clone(PILOT);

    assert.deepEqual(await committedFiles(found), ["merged.md", "seed.md"]);
    assert.equal(await readFile(path.join(found, "seed.md"), "utf8"), "mine\n");
  });

  it("refuses a clone whose branch has moved apart from its remote", async () => {
    const directory = await seeded();
    await landedElsewhere(directory, "merged.md");
    await writeFile(path.join(directory, "local.md"), "local\n");
    await run("git", ["-C", directory, "add", "local.md"]);
    await run("git", ["-C", directory, "commit", "--message", "Local only"]);

    await assert.rejects(
      githubRepoHost(locationOf(directory)).clone(PILOT),
      new RegExp(`${directory}.*cannot be brought up to date`),
    );
    // Refused, not rewritten: the local commit is still where it was.
    assert.deepEqual(await committedFiles(directory), ["local.md", "seed.md"]);
  });

  /**
   * A whole clone of another project — fetch, fast-forward and all — has to
   * finish while this one waits: far more git than this one has left, so a
   * catch-up that ignored the lock would have landed by then.
   */
  it("waits for the checkout lock before catching up, and only on its own checkout", HANGS, async () => {
    const directory = await seeded();
    const elsewhere = await seeded();
    await landedElsewhere(directory, "merged.md");
    await landedElsewhere(elsewhere, "merged.md");
    const lock = gate();
    const holding = withCheckoutLock(toCheckout(directory), () => lock.opened);

    const waiting = githubRepoHost(locationOf(directory)).clone(PILOT);
    await githubRepoHost(locationOf(elsewhere)).clone(PILOT);

    assert.deepEqual(await committedFiles(elsewhere), ["merged.md", "seed.md"]);
    assert.deepEqual(
      await committedFiles(directory),
      ["seed.md"],
      "the clone caught up while its checkout was locked",
    );
    lock.open();
    await holding;
    await waiting;
    assert.deepEqual(await committedFiles(directory), ["merged.md", "seed.md"]);
  });

  it("leaves the checkout free for the next run when catching up is refused", HANGS, async () => {
    const directory = await seeded();
    await landedElsewhere(directory, "merged.md");
    await writeFile(path.join(directory, "local.md"), "local\n");
    await run("git", ["-C", directory, "add", "local.md"]);
    await run("git", ["-C", directory, "commit", "--message", "Local only"]);

    await assert.rejects(
      githubRepoHost(locationOf(directory)).clone(PILOT),
      /cannot be brought up to date/,
    );

    assert.equal(
      await withCheckoutLock(toCheckout(directory), async () => "ran"),
      "ran",
    );
  });

  it("refuses a checkout of somebody else's repo of the same name", async () => {
    const directory = await checkout("someone-else/pilot");

    await assert.rejects(
      githubRepoHost(locationOf(directory)).clone(PILOT),
      /is a checkout of .*someone-else\/pilot/,
    );
  });

  it("puts a checkout at owner/repo, so two owners' repos of a name are two directories", async () => {
    const directory = await checkout();
    const location = locationOf(directory);

    assert.equal(
      await githubRepoHost(location).clone(PILOT),
      path.join(location, "nadav-alon", "pilot"),
    );
  });

  it("does not mistake a plain directory inside a repo for a checkout", async () => {
    const directory = await checkout();
    const nested = path.join(directory, "nadav-alon", "pilot");
    await mkdir(nested, { recursive: true });

    // Cloning is what the adapter should decide to do here, and it needs a
    // network to do it; that it got that far is the assertion.
    await assert.rejects(
      githubRepoHost(directory).clone(PILOT),
      (error: Error) => !/is a checkout of/.test(error.message),
    );
  });
});

/**
 * Opening the pull request a completed run is handed over as.
 *
 * The push is real, against a bare repo on disk. The `gh` half is a stub on
 * PATH that records how it was called: what this adapter owes the developer is
 * a draft pull request against the ticket, and the arguments are where that
 * promise is either kept or broken.
 */
describe("opening a draft pull request for a completed run", () => {
  const TICKET: Ticket = {
    repo: PILOT,
    number: 7,
    title: "Add the thing",
  };

  /**
   * The branch the managed clone is parked on, and so the base every pull
   * request here should be opened against.
   *
   * Deliberately not `main`: `gh` falls back to the remote's default branch
   * when no base is named, so a fixture based on `main` would pass whether the
   * adapter inferred the base or hardcoded it.
   */
  const BASE = "release-2";

  /**
   * A checkout carrying a branch of committed work, which is what the sandbox
   * fetches back when a run leaves commits behind. Left on `BASE`, the branch
   * the run was based on, as the sandbox found it.
   */
  async function ran(branch: string): Promise<Checkout> {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);

    await run("git", ["-C", directory, "switch", "--create", BASE]);
    await run("git", ["-C", directory, "push", "origin", BASE]);

    await run("git", ["-C", directory, "switch", "--create", branch]);
    await writeFile(path.join(directory, "thing.md"), "the thing\n");
    await run("git", ["-C", directory, "add", "thing.md"]);
    await run("git", ["-C", directory, "commit", "--message", "Add the thing"]);
    await run("git", ["-C", directory, "switch", BASE]);
    return toCheckout(directory);
  }

  /** The branch the run left its commits on, in every test here. */
  const RAN = "issue-7-add-the-thing";

  /**
   * The whole arrangement: a stubbed `gh` that answers with a pull request, a
   * checkout a run left commits in, and the pull request opened for it.
   *
   * Answers with the checkout and the stub, because what this adapter owes the
   * developer is split between the two: the push is visible in the checkout,
   * and the promise of a *draft* pull request against the ticket is kept or
   * broken in the arguments `gh` was handed.
   */
  async function openedFor(t: TestContext) {
    const gh = await recordingGh(t, `echo ${OPENED}`);
    const directory = await ran(RAN);

    const url = await githubRepoHost().openDraftPullRequest(
      directory,
      toBranch(RAN),
      TICKET,
    );
    const [call] = await gh.calls();
    return { directory, gh, url, call };
  }

  /** What the stubbed `gh` answers with, and so what the adapter should return. */
  const OPENED = "https://github.com/nadav-alon/pilot/pull/1";

  it("pushes the branch the run left its commits on", async (t) => {
    const { directory } = await openedFor(t);

    assert.deepEqual(await pushedFiles(directory, `origin/${RAN}`), [
      "seed.md",
      "thing.md",
    ]);
  });

  it("leaves the checkout on the branch it found it on", async (t) => {
    const { directory } = await openedFor(t);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "branch",
      "--show-current",
    ]);
    assert.equal(stdout.trim(), BASE);
  });

  it("answers with the pull request it opened", async (t) => {
    const { url } = await openedFor(t);

    assert.deepEqual(url, { kind: "opened", pullRequest: OPENED });
  });

  it("opens it as a draft, from the run's branch", async (t) => {
    const { call } = await openedFor(t);

    assert.deepEqual(call?.slice(0, 2), ["pr", "create"]);
    assert.ok(call?.includes("--draft"));
    assert.equal(valueOf(call, "--head"), RAN);
  });

  it("opens it against the branch the run was based on", async (t) => {
    const { call } = await openedFor(t);

    assert.equal(valueOf(call, "--base"), BASE);
  });

  it("waits for the checkout lock before pushing, and only on its own checkout", HANGS, async (t) => {
    const gh = await recordingGh(t, `echo ${OPENED}`);
    const directory = await ran(RAN);
    const elsewhere = await ran(RAN);
    const lock = gate();
    const holding = withCheckoutLock(directory, () => lock.opened);

    const waiting = githubRepoHost().openDraftPullRequest(
      directory,
      toBranch(RAN),
      TICKET,
    );
    await githubRepoHost().openDraftPullRequest(elsewhere, toBranch(RAN), TICKET);

    assert.deepEqual(await pushedFiles(elsewhere, `origin/${RAN}`), [
      "seed.md",
      "thing.md",
    ]);
    await assert.rejects(
      pushedFiles(directory, `origin/${RAN}`),
      "the branch was pushed while its checkout was locked",
    );
    assert.equal((await gh.calls()).length, 1);
    lock.open();
    await holding;
    await waiting;
    assert.deepEqual(await pushedFiles(directory, `origin/${RAN}`), [
      "seed.md",
      "thing.md",
    ]);
  });

  it("refuses rather than let gh choose the base, when there is no branch to name", async (t) => {
    const gh = await recordingGh(t, `echo ${OPENED}`);
    const directory = await ran(RAN);
    // A detached HEAD: `git branch --show-current` answers with nothing, and
    // a pull request opened without `--base` would take the remote's default
    // branch and every commit between it and the run.
    await run("git", ["-C", directory, "checkout", "--detach"]);

    const opening = await githubRepoHost().openDraftPullRequest(
      directory,
      toBranch(RAN),
      TICKET,
    );

    assert.equal(opening.kind, "unpushed");
    assert.match(
      opening.kind === "unpushed" ? opening.failure : "",
      /is not on a branch/,
    );

    // Refused before anything left the checkout, so nothing has to be undone.
    assert.deepEqual(await gh.calls(), []);
    await assert.rejects(pushedFiles(directory, `origin/${RAN}`));
  });

  it("names the project the ticket lives in, rather than letting gh choose", async (t) => {
    const { call } = await openedFor(t);

    assert.equal(valueOf(call, "--repo"), PILOT);
  });

  it("leaves the developer's checkout untracked against the run's branch", async (t) => {
    const { directory } = await openedFor(t);

    // The branch is the agent's, pushed by name. Writing tracking config for
    // it would change a checkout this adapter promised only to read.
    await assert.rejects(
      run("git", ["-C", directory, "config", `branch.${RAN}.remote`]),
    );
  });

  /**
   * A checkout whose run branch the host already has, carrying something else
   * — which is what a re-cloned checkout cannot see, since it looks for a free
   * branch name among its own refs. Pushing the run's branch from it is refused.
   */
  async function takenOnHost(): Promise<Checkout> {
    const directory = await ran(RAN);
    await run("git", ["-C", directory, "push", "origin", RAN]);
    await run("git", ["-C", directory, "switch", RAN]);
    await writeFile(path.join(directory, "thing.md"), "something else\n");
    await run("git", [
      "-C",
      directory,
      "commit",
      "--all",
      "--amend",
      "--message",
      "Add the thing",
    ]);
    await run("git", ["-C", directory, "switch", BASE]);
    return directory;
  }

  it("says so when the branch cannot be pushed", async (t) => {
    const gh = await recordingGh(t, `echo ${OPENED}`);
    const directory = await takenOnHost();

    const opening = await githubRepoHost().openDraftPullRequest(
      directory,
      toBranch(RAN),
      TICKET,
    );

    assert.equal(opening.kind, "unpushed");
    assert.match(
      opening.kind === "unpushed" ? opening.failure : "",
      new RegExp(`Could not push ${RAN}`),
    );

    // Nothing was asked of GitHub: there is no pushed branch to open against.
    assert.deepEqual(await gh.calls(), []);
  });

  it("leaves the checkout free for the next run when the push is refused", HANGS, async (t) => {
    await recordingGh(t, `echo ${OPENED}`);
    const directory = await takenOnHost();

    await githubRepoHost().openDraftPullRequest(directory, toBranch(RAN), TICKET);

    assert.equal(await withCheckoutLock(directory, async () => "ran"), "ran");
  });

  it("references the ticket it was run for", async (t) => {
    const { call } = await openedFor(t);

    assert.match(valueOf(call, "--body") ?? "", /#7\b/);
  });

  it("never promotes it out of draft, and never merges it", async (t) => {
    const { gh } = await openedFor(t);

    // Everything this adapter asked GitHub to do, not just the first thing:
    // a second call is exactly how a draft would stop being one.
    const commands = (await gh.calls()).map((call) =>
      call.slice(0, 2).join(" "),
    );
    assert.deepEqual(commands, ["pr create"]);
  });

  it("says where the commits are when the pull request cannot be opened", async (t) => {
    await recordingGh(t, "echo 'pull requests are disabled' >&2\nexit 1");
    const directory = await ran(RAN);

    const opening = await githubRepoHost().openDraftPullRequest(
      directory,
      toBranch(RAN),
      TICKET,
    );

    // Pushed, not unpushed: the branch is on the host, and that is where the
    // developer will look for it.
    assert.equal(opening.kind, "pushed");
    // The base, since a base the host does not have is the likeliest reason
    // `gh` refused, and it is not visible from the raw failure.
    assert.match(
      opening.kind === "pushed" ? opening.failure : "",
      new RegExp(`${BASE}.*pull requests are disabled`, "s"),
    );

    // The push happened before the pull request was asked for, so the work is
    // on the host and the message is what tells the developer where.
    assert.deepEqual(await pushedFiles(directory, `origin/${RAN}`), [
      "seed.md",
      "thing.md",
    ]);
  });

  it("says a pull request may exist, rather than that the branch was not pushed, when gh answers with something that is not one", async (t) => {
    await recordingGh(t, "echo 'something went sideways'");
    const directory = await ran(RAN);

    const opening = await githubRepoHost().openDraftPullRequest(
      directory,
      toBranch(RAN),
      TICKET,
    );

    assert.equal(opening.kind, "pushed");
    assert.match(
      opening.kind === "pushed" ? opening.failure : "",
      /something went sideways.*may have been opened/,
    );
    assert.deepEqual(await pushedFiles(directory, `origin/${RAN}`), [
      "seed.md",
      "thing.md",
    ]);
  });
});

describe("discarding a failed run's branch", () => {
  const FAILED = toBranch("issue-7-add-the-thing");

  /** A checkout with a commit behind it, as a project the loop works has. */
  async function seeded(): Promise<string> {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);
    return directory;
  }

  /**
   * A branch carrying a commit that is on no other branch — what the sandbox
   * fetches back after the agent has committed, built here with plumbing so
   * that no checkout has to move to make it.
   */
  async function unmerged(directory: string, name: string): Promise<void> {
    const head = await revision(directory, "HEAD");
    const tree = await revision(directory, "HEAD^{tree}");
    const { stdout } = await run("git", [
      "-C",
      directory,
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      "what the agent committed",
    ]);
    await run("git", ["-C", directory, "branch", name, stdout.trim()]);
  }

  async function revision(directory: string, of: string): Promise<string> {
    const { stdout } = await run("git", ["-C", directory, "rev-parse", of]);
    return stdout.trim();
  }

  async function branchesIn(directory: string): Promise<string[]> {
    const { stdout } = await run("git", [
      "-C",
      directory,
      "branch",
      "--format=%(refname:short)",
    ]);
    return stdout.split("\n").filter((line) => line !== "");
  }

  it("deletes the branch, unmerged commits and all", async () => {
    const directory = await seeded();
    await unmerged(directory, FAILED);
    // Merged branches delete either way; only an unmerged one proves the work
    // is actually being thrown away rather than tidied up after a merge.
    const { stdout: unmergedBranches } = await run("git", [
      "-C",
      directory,
      "branch",
      "--format=%(refname:short)",
      "--no-merged",
      "HEAD",
    ]);
    assert.match(unmergedBranches, new RegExp(FAILED));

    await githubRepoHost().discardBranch(toCheckout(directory), FAILED);

    assert.deepEqual(await branchesIn(directory), ["main"]);
  });

  it("says nothing about a branch the run never left, since it committed nothing", async () => {
    const directory = await seeded();

    await githubRepoHost().discardBranch(toCheckout(directory), FAILED);

    assert.deepEqual(await branchesIn(directory), ["main"]);
  });

  it("waits for the checkout lock before deleting, and only on its own checkout", HANGS, async () => {
    const directory = await seeded();
    const elsewhere = await seeded();
    await unmerged(directory, FAILED);
    await unmerged(elsewhere, FAILED);
    const lock = gate();
    const holding = withCheckoutLock(toCheckout(directory), () => lock.opened);

    const waiting = githubRepoHost().discardBranch(toCheckout(directory), FAILED);
    await githubRepoHost().discardBranch(toCheckout(elsewhere), FAILED);

    assert.deepEqual(await branchesIn(elsewhere), ["main"]);
    assert.deepEqual(
      await branchesIn(directory),
      [FAILED, "main"],
      "the branch was deleted while its checkout was locked",
    );
    lock.open();
    await holding;
    await waiting;
    assert.deepEqual(await branchesIn(directory), ["main"]);
  });

  it("leaves the checkout free for the next run when deleting is refused", HANGS, async () => {
    const directory = await seeded();
    await unmerged(directory, FAILED);
    // Git will not delete the branch a checkout is on.
    await run("git", ["-C", directory, "switch", FAILED]);

    await assert.rejects(
      githubRepoHost().discardBranch(toCheckout(directory), FAILED),
    );

    assert.equal(
      await withCheckoutLock(toCheckout(directory), async () => "ran"),
      "ran",
    );
  });

  it("leaves every other branch where it was", async () => {
    const directory = await seeded();
    await unmerged(directory, FAILED);
    await unmerged(directory, "issue-9-something-else");

    await githubRepoHost().discardBranch(toCheckout(directory), FAILED);

    assert.deepEqual(await branchesIn(directory), [
      "issue-9-something-else",
      "main",
    ]);
  });
});

describe("reading a pull request's apply-review answers", () => {
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/7",
  );
  const SINCE = new Date("2026-09-15T00:00:00Z");

  const BEFORE = "2026-09-14T00:00:00Z";
  const AFTER = "2026-09-15T01:00:00Z";
  const LATER = "2026-09-15T02:00:00Z";

  interface Comment {
    body: string;
    createdAt: string;
  }

  /** What `gh api graphql` answers with for a pull request carrying these. */
  function response({
    reviewThreads = [],
    reviews = [],
    comments = [],
  }: {
    reviewThreads?: { isResolved: boolean; comments: Comment[] }[];
    reviews?: { body: string; submittedAt: string | null }[];
    comments?: Comment[];
  }): string {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: reviewThreads.map((thread) => ({
                isResolved: thread.isResolved,
                comments: { nodes: thread.comments },
              })),
            },
            reviews: { nodes: reviews },
            comments: { nodes: comments },
          },
        },
      },
    });
  }

  const ASKED: Comment = { body: "Please fix this.", createdAt: BEFORE };

  function marked(body: string, createdAt = AFTER): Comment {
    return { body: `${body}\n${APPLY_REVIEW_MARKER}`, createdAt };
  }

  async function answersTo(t: TestContext, answer: string) {
    await recordingGh(t, `cat <<'JSON'\n${answer}\nJSON`);
    return githubRepoHost().readApplyReviewAnswers(PULL_REQUEST, SINCE);
  }

  const RESPONSE = response({
    reviewThreads: [{ isResolved: false, comments: [ASKED] }],
  });

  it("counts the applied reply on a review thread the skill resolved, without reading that thread as unanswered", async (t) => {
    const answers = await answersTo(
      t,
      response({
        reviewThreads: [
          { isResolved: true, comments: [ASKED, marked("Applied in abc123: brand the id")] },
          { isResolved: false, comments: [ASKED, marked("Declined: out of scope")] },
          { isResolved: false, comments: [ASKED] },
        ],
      }),
    );

    assert.deepEqual(answers, { appliedSince: 1, declinedSince: 1, unanswered: 1 });
  });

  it("ties a reply to the review body it quotes, not to every review", async (t) => {
    const answers = await answersTo(
      t,
      response({
        reviews: [
          { body: "", submittedAt: BEFORE },
          { body: "Rename the helper.", submittedAt: BEFORE },
          { body: "Add a test for the draft case.", submittedAt: BEFORE },
        ],
        comments: [marked("> Rename the helper.\n\nDeclined: out of scope")],
      }),
    );

    assert.deepEqual(answers, { appliedSince: 0, declinedSince: 1, unanswered: 1 });
  });

  it("reads a comment quoting no review as neither answering nor reopening one", async (t) => {
    const answers = await answersTo(
      t,
      response({
        reviews: [{ body: "Rename the helper.", submittedAt: BEFORE }],
        comments: [
          marked("> Rename the helper.\n\nApplied in abc123: renamed it"),
          { body: "The morning loop finished this ticket.", createdAt: LATER },
        ],
      }),
    );

    assert.deepEqual(answers, { appliedSince: 1, declinedSince: 0, unanswered: 0 });
  });

  it("names the field a response it cannot read is missing", async (t) => {
    await recordingGh(
      t,
      `echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[]}}}}}'`,
    );

    await assert.rejects(
      githubRepoHost().readApplyReviewAnswers(PULL_REQUEST, SINCE),
      /"comments" must be an object/,
    );
  });

  it("asks the pull request named by its own URL, not a repo it has to guess", async (t) => {
    const gh = await recordingGh(t, `cat <<'JSON'\n${RESPONSE}\nJSON`);

    await githubRepoHost().readApplyReviewAnswers(PULL_REQUEST, SINCE);

    const call = callWith(await gh.calls(), "graphql");
    assert.ok(call?.includes("owner=nadav-alon"));
    assert.ok(call?.includes("repo=pilot"));
    assert.ok(call?.includes("pr=7"));
  });
});

describe("checking a pull request for posted review findings", () => {
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/7",
  );
  const SINCE = new Date("2026-09-15T00:00:00Z");
  const BEFORE = "2026-09-14T00:00:00Z";
  const AFTER = "2026-09-15T01:00:00Z";

  const FINDING = {
    path: "src/thing.ts",
    line: 3,
    body: "Missing a null check here.",
  };

  function comments(entries: Record<string, unknown>[]): string {
    return JSON.stringify(entries);
  }

  async function checkedWith(t: TestContext, entries: Record<string, unknown>[]) {
    await recordingGh(t, `cat <<'JSON'\n${comments(entries)}\nJSON`);
    return githubRepoHost().hasReviewFindings(PULL_REQUEST, SINCE);
  }

  it("finds a finding posted after the read's instant", async (t) => {
    const found = await checkedWith(t, [{ ...FINDING, created_at: AFTER }]);

    assert.equal(found, true);
  });

  it("does not find one posted before the read's instant", async (t) => {
    const found = await checkedWith(t, [{ ...FINDING, created_at: BEFORE }]);

    assert.equal(found, false);
  });

  it("does not count a comment missing the finding's own shape, whatever else it carries", async (t) => {
    const found = await checkedWith(t, [{ body: "LGTM", created_at: AFTER }]);

    assert.equal(found, false);
  });

  it("reads the pull request's own inline review comments, named by its own URL", async (t) => {
    const gh = await recordingGh(t, `cat <<'JSON'\n${comments([])}\nJSON`);

    await githubRepoHost().hasReviewFindings(PULL_REQUEST, SINCE);

    assert.deepEqual(callWith(await gh.calls(), "api"), [
      "api",
      "repos/nadav-alon/pilot/pulls/7/comments",
    ]);
  });
});

describe("marking a pull request ready for review", () => {
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/7",
  );

  /** A `gh` that reports the pull request as a draft, or not. */
  const reportingDraft = (isDraft: boolean) =>
    `if [ "$2" = view ]; then echo ${isDraft}; fi`;

  it("marks the draft pull request named by its own URL ready", async (t) => {
    const gh = await recordingGh(t, reportingDraft(true));

    await githubRepoHost().markPullRequestReady(PULL_REQUEST);

    assert.deepEqual(callWith(await gh.calls(), "ready"), [
      "pr",
      "ready",
      PULL_REQUEST,
    ]);
  });

  it("leaves a pull request that is not a draft as it was, without an error", async (t) => {
    const gh = await recordingGh(t, reportingDraft(false));

    await githubRepoHost().markPullRequestReady(PULL_REQUEST);

    assert.equal(callWith(await gh.calls(), "ready"), undefined);
  });
});

describe("whether a pull request's branch needs a rebase", () => {
  const PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/7",
  );

  /** No delay between retries, so a test with several stays as fast as one with none. */
  const NO_WAIT = async () => {};

  /**
   * A `gh` that answers `mergeable` with each of `statuses` in turn, then
   * repeats the last — tracked with a counter file, since each read is a
   * fresh process with nothing else to remember its call count by.
   */
  async function answering(t: TestContext, ...statuses: string[]) {
    const counter = path.join(
      await mkdtemp(path.join(tmpdir(), "merge-status-")),
      "n",
    );
    const cases = statuses
      .map((status, index) => `  ${index}) echo "${status}" ;;`)
      .join("\n");
    return recordingGh(
      t,
      [
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        `echo $((n + 1)) > "${counter}"`,
        `case "$n" in`,
        cases,
        `  *) echo "${statuses.at(-1)}" ;;`,
        `esac`,
      ].join("\n"),
    );
  }

  it("says a conflicting pull request needs a rebase", async (t) => {
    await answering(t, "CONFLICTING");

    assert.equal(
      await githubRepoHost(undefined, NO_WAIT).needsRebase(PULL_REQUEST),
      true,
    );
  });

  it("says a clean pull request does not need a rebase", async (t) => {
    await answering(t, "MERGEABLE");

    assert.equal(
      await githubRepoHost(undefined, NO_WAIT).needsRebase(PULL_REQUEST),
      false,
    );
  });

  it("retries a pull request that answers unknown before it settles", async (t) => {
    await answering(t, "UNKNOWN", "UNKNOWN", "CONFLICTING");

    assert.equal(
      await githubRepoHost(undefined, NO_WAIT).needsRebase(PULL_REQUEST),
      true,
    );
  });

  it("throws, naming the pull request and the unsettled status, once retries are exhausted", async (t) => {
    await answering(t, "UNKNOWN");

    await assert.rejects(
      githubRepoHost(undefined, NO_WAIT).needsRebase(PULL_REQUEST),
      (error: unknown) => {
        assert.ok(error instanceof MergeabilityUnknown);
        assert.equal(error.pullRequest, PULL_REQUEST);
        assert.equal(error.lastStatus, "unknown");
        return true;
      },
    );
  });

  it("asks about one pull request at a time, never gh pr list", async (t) => {
    const gh = await answering(t, "MERGEABLE");

    await githubRepoHost(undefined, NO_WAIT).needsRebase(PULL_REQUEST);

    const calls = await gh.calls();
    assert.deepEqual(
      calls.map((call) => call.slice(0, 2)),
      [["pr", "view"]],
    );
    assert.ok(calls[0]?.includes(PULL_REQUEST));
  });
});

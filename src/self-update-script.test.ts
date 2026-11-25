import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  documentStore,
  SELF_UPDATE_FAILURE_ANNOUNCED_FILE,
  SELF_UPDATE_FAILURE_FILE,
} from "./adapters/document-store.ts";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/self-update.sh");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

/** A checkout whose upstream has since moved a file the checkout has also edited locally, so a fast-forward pull cannot apply. */
async function conflictedCheckout(): Promise<{ checkout: string; upstream: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "self-update-"));
  const upstream = path.join(root, "upstream");
  const checkout = path.join(root, "checkout");
  git(root, "init", "-q", "-b", "main", upstream);
  await writeFile(path.join(upstream, "registry.json"), "[]\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "first");
  git(root, "clone", "-q", upstream, checkout);
  await writeFile(path.join(upstream, "registry.json"), '["a"]\n');
  git(upstream, "commit", "-qam", "second");
  await writeFile(path.join(checkout, "registry.json"), '["local"]\n');
  return { checkout, upstream, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function run(checkout: string): { output: string } {
  const result = spawnSync(SCRIPT, [checkout], {
    env: { ...GIT_ENV, SIDE_PROJECTS_MANAGER_HOME: checkout },
    encoding: "utf8",
  });
  return { output: result.stdout + result.stderr };
}

describe("scripts/self-update.sh", () => {
  it("leaves git's reason for the loop when the pull fails, tells a streak once, and clears on a pull that succeeds", async () => {
    const { checkout, cleanup } = await conflictedCheckout();
    try {
      run(checkout);
      assert.match(await readFile(path.join(checkout, SELF_UPDATE_FAILURE_FILE), "utf8"), /registry\.json/);

      // The real handoff: the store marks it announced, and the next failing pull writes nothing.
      const store = documentStore(checkout);
      const failure = await store.loadSelfUpdateFailure();
      assert.ok(failure !== undefined);
      await store.markSelfUpdateFailureAnnounced(failure);
      run(checkout);
      assert.equal(await store.loadSelfUpdateFailure(), undefined);
      await rm(path.join(checkout, SELF_UPDATE_FAILURE_ANNOUNCED_FILE));

      // The loop announced it: the streak's later failures leave nothing new.
      await rm(path.join(checkout, SELF_UPDATE_FAILURE_FILE), { force: true });
      await writeFile(path.join(checkout, SELF_UPDATE_FAILURE_ANNOUNCED_FILE), "");
      run(checkout);
      assert.ok(!(await readdir(checkout)).includes(SELF_UPDATE_FAILURE_FILE));

      git(checkout, "checkout", "--", "registry.json");
      run(checkout);
      const left = await readdir(checkout);
      assert.ok(!left.includes(SELF_UPDATE_FAILURE_FILE));
      assert.ok(!left.includes(SELF_UPDATE_FAILURE_ANNOUNCED_FILE));
    } finally {
      await cleanup();
    }
  });

  it("changes nothing on a pull that succeeds", async () => {
    const { checkout, cleanup } = await conflictedCheckout();
    try {
      git(checkout, "checkout", "--", "registry.json");
      const before = await readdir(checkout);
      // Nothing on stdout or stderr, so nothing reaches trigger.log.
      assert.equal(run(checkout).output, "");
      assert.deepEqual(await readdir(checkout), before);
    } finally {
      await cleanup();
    }
  });
});

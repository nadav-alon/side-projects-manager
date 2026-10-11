import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { branch } from "../ports/branch.ts";
import { pushGuardHookCommand, pushRefusal, type PushPolicy } from "./push-guard.ts";

const PLAIN: PushPolicy = { base: branch("master"), lease: false };
const LEASING: PushPolicy = { base: branch("master"), lease: true };

function refusal(command: string, policy = PLAIN, current: string | undefined = "feature") {
  return pushRefusal(command, policy, () => current);
}

describe("pushRefusal: the base branch", () => {
  for (const command of [
    "git push origin master",
    "git push -u origin master",
    "git push origin HEAD:master",
    "git push origin HEAD:refs/heads/master",
    "git push origin feature:master",
    "git push origin :master",
    "git push origin refs/heads/master",
    "git push origin 'master'",
    "git push --all",
    "git push origin 'refs/heads/*:refs/heads/*'",
    "git -C . push origin master",
    "cd x && git push origin master",
    "git fetch; git push origin master | cat",
    "(git push origin master)",
    "echo $(git push origin master)",
    "env GIT_TRACE=1 git push origin master",
    "sudo git push origin master",
    "bash -c 'git push origin master'",
    'sh -c "git push origin master"',
    "/usr/bin/git push origin master",
    "git push origin feature master",
    "git push origin feature:heads/master",
    "git push origin HEAD:heads/master",
    "git push origin :",
    "git push -uo ci.skip origin master",
    "git push --repo=x -o ci.skip origin master",
  ]) {
    it(`refuses ${command}`, () => {
      assert.match(refusal(command) ?? "", /a push to master/);
    });
  }

  it("refuses a push with no refspec while on the base branch", () => {
    assert.match(refusal("git push", PLAIN, "master") ?? "", /a push to master/);
    assert.match(refusal("git push origin", PLAIN, "master") ?? "", /a push to master/);
    assert.match(refusal("git push origin HEAD", PLAIN, "master") ?? "", /a push to master/);
  });

  it("asks for the branch of the directory the push is run in", () => {
    const asked: string[][] = [];
    pushRefusal("git -C a -C b push", PLAIN, (directories) => {
      asked.push(directories);
      return "feature";
    });
    assert.deepEqual(asked, [["a", "b"]]);
  });

  it("reads an option missing its value at the end of the command", () => {
    assert.equal(refusal("git -C", PLAIN, "master"), undefined);
    assert.equal(refusal("git -c", PLAIN, "master"), undefined);
    assert.match(refusal("git push --repo", PLAIN, "master") ?? "", /a push to master/);
    assert.match(refusal("git push -o", PLAIN, "master") ?? "", /a push to master/);
  });

  it("lets a push of another branch through, to every run", () => {
    for (const policy of [PLAIN, LEASING]) {
      for (const command of [
        "git push",
        "git push origin",
        "git push origin HEAD",
        "git push -u origin feature",
        "git push origin feature:feature",
        "git push origin master-2",
        "git push origin feature --tags",
        "git push origin v1.0",
        "git status && git log master",
        "git pull origin master",
        "git push -ofoo origin feature",
        "git push -o ci.skip origin feature",
      ]) {
        assert.equal(refusal(command, policy), undefined, command);
      }
    }
  });

  it("refuses a push it cannot read the destination of", () => {
    for (const command of [
      "git push $ARGS",
      "git push origin $'master'",
      "git push origin {master,feature}",
      "git -c remote.origin.push=+HEAD:feature push",
      "git -c alias.x=push x -f",
      "git -c push.default=upstream push",
      "git -c push.default=current push origin master",
      "git -c remote.origin.push=HEAD:master push",
      "git checkout master && git push origin HEAD",
      "git switch master; git push",
      "cd sub && git push",
    ]) {
      assert.match(refusal(command) ?? "", /a (push whose destination|force-push)/, command);
    }
  });

  it("does not refuse a push without a refspec from a detached HEAD", () => {
    assert.equal(refusal("git push", PLAIN, undefined), undefined);
  });
});

describe("pushRefusal: force-pushes", () => {
  for (const command of [
    "git push --force",
    "git push -f",
    "git push -fu origin feature",
    "git push origin feature --force",
    "git push origin +feature",
    "git push origin +HEAD:feature",
    "git -C . push --force",
    "git push --mirror",
    "git push --force --force-with-lease origin feature",
  ]) {
    it(`refuses ${command} to a leasing run too`, () => {
      assert.match(refusal(command, LEASING) ?? "", /a (force-push|push to master)/);
      assert.match(refusal(command, PLAIN) ?? "", /a (force-push|push to master)/);
    });
  }

  for (const command of [
    "git push --force-with-lease",
    "git push --force-with-lease=feature:abc origin feature",
    "git push --force-with-lease --force-if-includes origin feature",
  ]) {
    it(`refuses ${command} to a plain run only`, () => {
      assert.match(refusal(command, PLAIN) ?? "", /a force-push/);
      assert.equal(refusal(command, LEASING), undefined);
    });
  }

  it("never lets --force-with-lease reach the base branch", () => {
    for (const command of [
      "git push --force-with-lease origin master",
      "git push --force-with-lease origin HEAD:master",
      "git push --force-with-lease",
    ]) {
      assert.match(refusal(command, LEASING, "master") ?? "", /a push to master/, command);
    }
  });
});

describe("pushGuardHookCommand", () => {
  const run = (command: string, input: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = execFile("sh", ["-c", command], (error, _stdout, stderr) =>
        resolve({ code: error === null ? 0 : (error.code as number | null), stderr }),
      );
      child.stdin?.end(input);
    });

  const call = (command: string, cwd?: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });

  it("exits 2 naming the refusal for a push to the base branch or a force-push", async () => {
    const hook = pushGuardHookCommand(PLAIN);
    const base = await run(hook, call("git push origin master"));
    assert.equal(base.code, 2);
    assert.match(base.stderr, /a push to master/);
    const force = await run(hook, call("git push -f origin feature"));
    assert.equal(force.code, 2);
    assert.match(force.stderr, /a force-push/);
  });

  it("lets a leasing run use --force-with-lease and anything that is not a push", async () => {
    const hook = pushGuardHookCommand(LEASING);
    assert.equal((await run(hook, call("git push --force-with-lease origin feature"))).code, 0);
    assert.equal((await run(hook, call("git status"))).code, 0);
    assert.equal((await run(hook, JSON.stringify({ tool_name: "Write", tool_input: {} }))).code, 0);
    assert.equal((await run(hook, "not json")).code, 0);
  });

  it("reads the current branch of the directory the call ran in", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "push-guard-"));
    try {
      await new Promise((resolve, reject) =>
        execFile("git", ["init", "-q", "-b", "master", directory], (e) => (e ? reject(e) : resolve(null))),
      );
      const hook = pushGuardHookCommand(PLAIN);
      assert.equal((await run(hook, call("git push", directory))).code, 2);
      assert.equal((await run(hook, call("git push", path.join(directory, "missing")))).code, 0);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

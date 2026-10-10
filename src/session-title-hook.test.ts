import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const script = path.join(import.meta.dirname, "..", "scripts", "session-title-hook.ts");

let checkout: string;

before(() => {
  checkout = mkdtempSync(path.join(tmpdir(), "session-title-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/nadav-alon/pilot.git"], {
    cwd: checkout,
  });
});

after(() => {
  rmSync(checkout, { recursive: true, force: true });
});

function runHook(input: Record<string, unknown>) {
  const result = spawnSync("node", [script], {
    input: JSON.stringify({ cwd: checkout, hook_event_name: "UserPromptSubmit", ...input }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout === "" ? undefined : JSON.parse(result.stdout);
}

for (const mode of ["grilling", "grill-me", "standup", "triage", "wayfinder"]) {
  test(`/${mode} titles the session and the tab after the mode and the repo`, () => {
    const title = `${mode}: nadav-alon/pilot`;
    assert.deepEqual(runHook({ prompt: `/${mode}` }), {
      terminalSequence: `\u001b]2;${title}\u0007`,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title },
    });
  });
}

test("a plugin-qualified skill name titles by the bare mode", () => {
  const out = runHook({ prompt: "/mattpocock-skills:grilling" });
  assert.equal(out.hookSpecificOutput.sessionTitle, "grilling: nadav-alon/pilot");
});

for (const prompt of ["fix the bug", "/tdd", "/grillingly", "please /standup", ""]) {
  test(`${JSON.stringify(prompt)} passes through with no output`, () => {
    assert.equal(runHook({ prompt }), undefined);
  });
}

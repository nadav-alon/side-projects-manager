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

test("a ticket named in the arguments is appended to the title", () => {
  for (const prompt of ["/grilling pilot#42", "/triage #42", "/standup https://github.com/nadav-alon/pilot/issues/42"]) {
    const mode = /^\/(\w+)/.exec(prompt)![1];
    assert.equal(runHook({ prompt }).hookSpecificOutput.sessionTitle, `${mode}: nadav-alon/pilot#42`);
  }
});

test("a session titled by hand is left alone, one titled by the hook is retitled", () => {
  assert.equal(runHook({ prompt: "/standup", session_title: "my own name" }), undefined);
  const out = runHook({ prompt: "/triage #7", session_title: "standup: nadav-alon/pilot" });
  assert.equal(out.hookSpecificOutput.sessionTitle, "triage: nadav-alon/pilot#7");
});

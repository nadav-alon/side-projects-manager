import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const prompt of ["/grilling nadav-alon/pilot#42", "/triage #42", "/standup https://github.com/nadav-alon/pilot/issues/42"]) {
    const mode = /^\/(\w+)/.exec(prompt)![1];
    assert.equal(runHook({ prompt }).hookSpecificOutput.sessionTitle, `${mode}: nadav-alon/pilot#42`);
  }
});

test("a ticket of another repo is not appended to this repo's title", () => {
  for (const prompt of ["/grilling other/repo#42", "/standup https://github.com/other/repo/issues/42"]) {
    const mode = /^\/(\w+)/.exec(prompt)![1];
    assert.equal(runHook({ prompt }).hookSpecificOutput.sessionTitle, `${mode}: nadav-alon/pilot`);
  }
});

test("a hand title sharing our prefix is left alone", () => {
  assert.equal(runHook({ prompt: "/triage", session_title: "triage: notes for Q3" }), undefined);
});

test("empty or malformed stdin passes through with no output", () => {
  for (const input of ["", "not json"]) {
    const result = spawnSync("node", [script], { input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("with no origin the directory name titles the session, stripped of control characters", () => {
  const bare = mkdtempSync(path.join(tmpdir(), "bare\u0007dir-"));
  try {
    const out = runHook({ prompt: "/triage", cwd: bare });
    assert.equal(out.hookSpecificOutput.sessionTitle, `triage: ${path.basename(bare).replace("\u0007", "")}`);
    assert.ok(!out.terminalSequence.slice(4, -1).includes("\u0007"));
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("a session titled by hand is left alone, one titled by the hook is retitled", () => {
  assert.equal(runHook({ prompt: "/standup", session_title: "my own name" }), undefined);
  const out = runHook({ prompt: "/triage #7", session_title: "standup: nadav-alon/pilot" });
  assert.equal(out.hookSpecificOutput.sessionTitle, "triage: nadav-alon/pilot#7");
});

test("the installer merges into an existing hooks block and is safe to re-run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-title-settings-"));
  try {
    const settings = path.join(dir, "nested", "settings.json");
    const installer = path.join(import.meta.dirname, "..", "scripts", "install-session-title-hook.ts");
    const install = () => execFileSync("node", [installer, settings]);
    const read = () => JSON.parse(readFileSync(settings, "utf8"));

    install();
    assert.equal(read().hooks.UserPromptSubmit.length, 1);

    const other = { hooks: [{ type: "command", command: "echo hi" }] };
    writeFileSync(
      settings,
      JSON.stringify({ model: "x", hooks: { Stop: [other], UserPromptSubmit: [other] } }),
    );
    install();
    install();
    const after = read();
    assert.equal(after.model, "x");
    assert.deepEqual(after.hooks.Stop, [other]);
    assert.equal(after.hooks.UserPromptSubmit.length, 2);
    assert.deepEqual(after.hooks.UserPromptSubmit[0], other);
    assert.ok(after.hooks.UserPromptSubmit[1].hooks[0].command.includes(script));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

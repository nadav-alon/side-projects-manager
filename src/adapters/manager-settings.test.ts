import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branch } from "../ports/branch.ts";
import { cliSettings } from "./manager-settings.ts";

function hookCommand(kind: Parameters<typeof cliSettings>[0]): string {
  const { hooks } = JSON.parse(cliSettings(kind, branch("master")));
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, "Bash");
  return hooks.PreToolUse[0].hooks[0].command;
}

describe("cliSettings", () => {
  it("hands every kind a PreToolUse hook on Bash that guards pushes", () => {
    for (const kind of ["run", "review", "rebase", "apply-review"] as const) {
      assert.match(hookCommand(kind), /^node -e /);
    }
  });

  it("gives the hook of a force-pushing kind its --force-with-lease allowance alone", () => {
    assert.notEqual(hookCommand("rebase"), hookCommand("run"));
    assert.equal(hookCommand("rebase"), hookCommand("apply-review"));
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

test("the state document and the journal are not committed", () => {
  for (const document of ["state.json", "journal.json"]) {
    assert.equal(isIgnored(document), true, `${document} is not gitignored`);
  }
});

test("the budget document is not committed", () => {
  assert.equal(isIgnored("budget.json"), true);
});

test("the registry stays committed", () => {
  assert.equal(isIgnored("registry.json"), false);
});

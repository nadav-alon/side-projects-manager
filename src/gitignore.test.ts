import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;

function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

test("the machine-written documents are not committed", () => {
  for (const document of ["state.json", "journal.json", "budget.json"]) {
    assert.equal(isIgnored(document), true, `${document} is not gitignored`);
  }
});

test("the registry stays committed", () => {
  assert.equal(isIgnored("registry.json"), false);
});

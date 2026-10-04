import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { MANAGER_HOME } from "./adapters/manager-home.ts";

const standards = readFileSync(path.join(MANAGER_HOME, "docs/agents/coding-standards.md"), "utf8");

describe("the uniform coding standards", () => {
  it("has no section on branding primitives, which is a language's rule", () => {
    assert.doesNotMatch(standards, /Brand your primitives/);
  });

  it("assumes no language", () => {
    assert.doesNotMatch(standards, /zod|unique symbol|erasableSyntaxOnly|npm|tsc|```\w/);
  });

  it("opens by saying runs and the review read it with the project standards", () => {
    const opening = standards.split("\n## ")[0] ?? "";

    assert.match(opening, /Implementation runs/);
    assert.match(opening, /docs\/project-standards\.md/);
  });

  it("says how the project standards relate to it", () => {
    const section = standards.split("\n## Project standards\n")[1]?.split("\n## ")[0] ?? "";

    assert.match(section, /bind/);
    assert.match(section, /naming that rule's heading/);
    assert.match(section, /the rule here wins/);
    assert.match(section, /correction discovery/);
  });
});

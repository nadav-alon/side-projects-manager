import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { NAMES_THE_MANAGER } from "./testing/names-the-manager.ts";

const standards = readFileSync("docs/agents/coding-standards.md", "utf8");

describe("the uniform coding standards", () => {
  it("has no section on branding primitives, which is a language's rule", () => {
    assert.doesNotMatch(standards, /Brand your primitives/);
  });

  it("assumes no language", () => {
    assert.doesNotMatch(standards, /zod|unique symbol|erasableSyntaxOnly|npm|tsc/);
  });

  it("names nothing of the manager", () => {
    assert.doesNotMatch(standards, NAMES_THE_MANAGER);
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UNIFORM_FILES } from "./adapters/directory-harness.ts";
import { agentInstructions } from "./agent-instructions.ts";
import { repoSlug } from "./ports/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");

function pilot(description = "A flight log that files itself."): string {
  return agentInstructions({ repo: PILOT, description });
}

describe("the agent instructions a new project gets", () => {
  it("is titled with the project, not with whoever scaffolded it", () => {
    assert.match(pilot(), /^# pilot\n/);
  });

  it("says what this project is, in the developer's own words", () => {
    assert.match(pilot("A flight log that files itself."), /A flight log that files itself\./);
  });

  it("points at the project's own copies of the uniform files", () => {
    const instructions = pilot();

    for (const file of UNIFORM_FILES) {
      assert.match(instructions, new RegExp(file.replaceAll(".", "\\.")));
    }
  });

  it("carries no reference back to the manager, so the project stands alone", () => {
    const instructions = pilot("A manager for flight logs.").toLowerCase();

    // The description is the developer's and may say anything; every other
    // line is generated, and none of it may point home.
    const generated = instructions.replaceAll("a manager for flight logs.", "");
    assert.doesNotMatch(generated, /side-projects-manager|morning loop|manager home|registry\.json/);
  });

  it("describes a project with no description without an empty line where it would be", () => {
    assert.doesNotMatch(pilot(""), /\n\n\n/);
  });

  it("ends with a newline, being a file that gets committed", () => {
    assert.match(pilot(), /[^\n]\n$/);
  });
});

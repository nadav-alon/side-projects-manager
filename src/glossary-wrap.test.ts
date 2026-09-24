import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { GLOSSARY_WRAP_WIDTH, unwrappedGlossaryLines } from "./glossary-wrap.ts";

function contextMd(...glossaryLines: string[]): string {
  return ["# A project", "", "An intro paragraph, outside the glossary.", "", "## Language", ...glossaryLines].join(
    "\n",
  );
}

describe("unwrappedGlossaryLines", () => {
  it("reports nothing for a glossary wrapped at the width", () => {
    const md = contextMd("**Term**:", "x".repeat(GLOSSARY_WRAP_WIDTH));
    assert.deepEqual(unwrappedGlossaryLines(md), []);
  });

  it("reports a glossary line one column over the width, by its line number", () => {
    const md = contextMd("**Term**:", "x".repeat(GLOSSARY_WRAP_WIDTH + 1));
    assert.deepEqual(unwrappedGlossaryLines(md), [7]);
  });

  it("ignores an overlong line before the glossary heading", () => {
    const md = ["# A project", "x".repeat(GLOSSARY_WRAP_WIDTH + 1), "", "## Language", "**Term**:", "fine"].join(
      "\n",
    );
    assert.deepEqual(unwrappedGlossaryLines(md), []);
  });

  it("reports every overlong line, in order", () => {
    const md = contextMd(
      "**First**:",
      "x".repeat(GLOSSARY_WRAP_WIDTH + 1),
      "",
      "**Second**:",
      "y".repeat(GLOSSARY_WRAP_WIDTH + 5),
    );
    assert.deepEqual(unwrappedGlossaryLines(md), [7, 10]);
  });

  it("throws rather than silently pass when the glossary heading is missing", () => {
    assert.throws(() => unwrappedGlossaryLines("# A project\n\nNo glossary here.\n"), /## Language/);
  });
});

describe("CONTEXT.md's glossary", () => {
  it("stays wrapped at the file's width, so tickets keep sentence-granularity merges", () => {
    const contents = readFileSync(fileURLToPath(new URL("../CONTEXT.md", import.meta.url)), "utf8");
    assert.deepEqual(unwrappedGlossaryLines(contents), []);
  });
});

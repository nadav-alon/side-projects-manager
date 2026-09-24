import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isNits, nits } from "./nits.ts";

describe("isNits", () => {
  it("accepts non-blank text", () => {
    assert.equal(isNits("- names.ts still says `id` where the glossary says `slug`."), true);
  });

  it("accepts more than one line", () => {
    assert.equal(isNits("- first nit.\n- second nit."), true);
  });

  it("rejects an empty string", () => {
    assert.equal(isNits(""), false);
  });

  it("rejects text that is only whitespace", () => {
    assert.equal(isNits("   \n  "), false);
  });
});

describe("nits", () => {
  it("narrows well-formed text", () => {
    assert.equal(
      nits("- names.ts still says `id` where the glossary says `slug`."),
      "- names.ts still says `id` where the glossary says `slug`.",
    );
  });

  it("throws naming the offending value", () => {
    assert.throws(() => nits(""), { name: "TypeError", message: /""/ });
  });
});

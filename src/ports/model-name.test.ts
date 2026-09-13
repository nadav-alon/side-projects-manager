import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isModelName, modelName } from "./model-name.ts";

describe("isModelName", () => {
  it("accepts an alias and a full model id alike, since names are never checked against a list", () => {
    assert.equal(isModelName("sonnet"), true);
    assert.equal(isModelName("claude-opus-5"), true);
    assert.equal(isModelName("some-model-nobody-has-heard-of"), true);
  });

  it("rejects an empty name, which names no model at all", () => {
    assert.equal(isModelName(""), false);
  });

  it("rejects a name containing whitespace, which no model id carries", () => {
    assert.equal(isModelName(" "), false);
    assert.equal(isModelName("claude opus"), false);
    assert.equal(isModelName("opus\n"), false);
  });

  it("rejects a name that reads as an option, which the CLI would take for a flag", () => {
    assert.equal(isModelName("--dangerously-skip-permissions"), false);
    assert.equal(isModelName("-p"), false);
  });
});

describe("modelName", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => modelName("claude opus"), {
      name: "TypeError",
      message: /"claude opus"/,
    });
  });
});

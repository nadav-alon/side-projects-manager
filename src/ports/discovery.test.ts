import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DISCOVERY_KINDS,
  isBlockingDiscoveryKind,
  isDiscovery,
  type DiscoveryKind,
} from "./discovery.ts";

describe("isBlockingDiscoveryKind", () => {
  it("treats a correction and a prerequisite as blocking", () => {
    assert.equal(isBlockingDiscoveryKind("correction"), true);
    assert.equal(isBlockingDiscoveryKind("prerequisite"), true);
  });

  it("treats a clarification and a suggestion as advisory", () => {
    assert.equal(isBlockingDiscoveryKind("clarification"), false);
    assert.equal(isBlockingDiscoveryKind("suggestion"), false);
  });
});

describe("isDiscovery", () => {
  for (const kind of DISCOVERY_KINDS) {
    it(`accepts a well-formed ${kind}`, () => {
      assert.equal(
        isDiscovery({ kind, title: "The ticket is wrong", body: "Because…" }),
        true,
      );
    });
  }

  it("rejects a kind outside the four", () => {
    assert.equal(
      isDiscovery({ kind: "observation", title: "x", body: "y" }),
      false,
    );
  });

  it("rejects a missing title or body", () => {
    assert.equal(isDiscovery({ kind: "suggestion", body: "y" }), false);
    assert.equal(isDiscovery({ kind: "suggestion", title: "x" }), false);
  });

  it("accepts an empty title or body: DISCOVERY_INSTRUCTIONS never asks for non-empty ones", () => {
    assert.equal(isDiscovery({ kind: "suggestion", title: "", body: "y" }), true);
    assert.equal(isDiscovery({ kind: "suggestion", title: "x", body: "" }), true);
  });

  it("rejects anything that is not an object", () => {
    assert.equal(isDiscovery(null), false);
    assert.equal(isDiscovery("a string"), false);
    assert.equal(isDiscovery(42), false);
    assert.equal(isDiscovery(undefined), false);
  });

  it("narrows to DiscoveryKind once accepted", () => {
    const value: unknown = { kind: "clarification", title: "x", body: "y" };
    if (isDiscovery(value)) {
      const kind: DiscoveryKind = value.kind;
      assert.equal(kind, "clarification");
    } else {
      assert.fail("expected a well-formed discovery");
    }
  });
});

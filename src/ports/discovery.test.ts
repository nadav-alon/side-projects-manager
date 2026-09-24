import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DISCOVERY_KINDS,
  isDiscovery,
  normalizeDiscovery,
  type Discovery,
  type DiscoveryKind,
} from "./discovery.ts";

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

  it("accepts a well-formed discovery with ready true or false", () => {
    assert.equal(
      isDiscovery({ kind: "suggestion", title: "x", body: "y", ready: true }),
      true,
    );
    assert.equal(
      isDiscovery({ kind: "prerequisite", title: "x", body: "y", ready: false }),
      true,
    );
  });

  it("accepts a ready that is not a boolean: a malformed optional field costs ready, not the discovery", () => {
    assert.equal(
      isDiscovery({ kind: "suggestion", title: "x", body: "y", ready: "true" }),
      true,
    );
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

describe("normalizeDiscovery", () => {
  it("carries every declared field through, including ready", () => {
    const value: Discovery = {
      kind: "suggestion",
      title: "Add a retry",
      body: "Would have added retries myself.",
      ready: true,
    };

    assert.deepEqual(normalizeDiscovery(value), value);
  });

  it("drops an undeclared key the parsed value still carries at runtime", () => {
    const value = {
      kind: "clarification",
      title: "Read as opt-in",
      body: "The ticket never says default on.",
      extra: "not part of Discovery",
    } as unknown as Discovery;

    assert.deepEqual(normalizeDiscovery(value), {
      kind: "clarification",
      title: "Read as opt-in",
      body: "The ticket never says default on.",
    });
  });

  it("omits ready rather than keeping it false", () => {
    const value: Discovery = {
      kind: "correction",
      title: "Wrong file",
      body: "It's actually in the other module.",
      ready: false,
    };

    assert.deepEqual(normalizeDiscovery(value), {
      kind: "correction",
      title: "Wrong file",
      body: "It's actually in the other module.",
    });
  });
});

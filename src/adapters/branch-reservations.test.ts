import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isBranchReserved,
  reserveBranch,
  unreserveBranch,
} from "./branch-reservations.ts";
import { branch, checkout } from "../ports/index.ts";

const PILOT = checkout("/projects/pilot");
const OTHER = checkout("/projects/other");
const NAME = branch("issue-7-reserve");

describe("branch reservations", () => {
  it("holds a name until it is handed back", () => {
    reserveBranch(PILOT, NAME);
    assert.equal(isBranchReserved(PILOT, NAME), true);

    unreserveBranch(PILOT, NAME);
    assert.equal(isBranchReserved(PILOT, NAME), false);
  });

  it("holds a name only on the checkout it was reserved on", () => {
    reserveBranch(PILOT, NAME);
    try {
      assert.equal(isBranchReserved(OTHER, NAME), false);
    } finally {
      unreserveBranch(PILOT, NAME);
    }
  });

  it("hands back only the name asked for", () => {
    const second = branch(`${NAME}-2`);
    reserveBranch(PILOT, NAME);
    reserveBranch(PILOT, second);

    unreserveBranch(PILOT, NAME);

    assert.equal(isBranchReserved(PILOT, second), true);
    unreserveBranch(PILOT, second);
  });
});

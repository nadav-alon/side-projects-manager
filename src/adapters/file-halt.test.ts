import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tempHome } from "../testing/index.ts";
import { fileHalt } from "./file-halt.ts";

async function home(): Promise<string> {
  return tempHome("halt");
}

describe("the file halt", () => {
  it("is not engaged on a fresh checkout", async () => {
    const halt = fileHalt(await home());

    assert.equal(await halt.engaged(), false);
  });

  it("is engaged once engaged", async () => {
    const halt = fileHalt(await home());
    await halt.engage();

    assert.equal(await halt.engaged(), true);
  });

  it("reports it engaged the halt, the first time", async () => {
    const halt = fileHalt(await home());

    assert.equal(await halt.engage(), true);
  });

  it("reports it did not engage the halt, the second time", async () => {
    const halt = fileHalt(await home());
    await halt.engage();

    assert.equal(await halt.engage(), false);
    assert.equal(await halt.engaged(), true, "still engaged");
  });

  it("reports it cleared the halt, the first time", async () => {
    const halt = fileHalt(await home());
    await halt.engage();

    assert.equal(await halt.clear(), true);
    assert.equal(await halt.engaged(), false);
  });

  it("reports it did not clear the halt, when it was never engaged", async () => {
    const halt = fileHalt(await home());

    assert.equal(await halt.clear(), false);
  });

  it("reports it did not clear the halt, the second time", async () => {
    const halt = fileHalt(await home());
    await halt.engage();
    await halt.clear();

    assert.equal(await halt.clear(), false);
  });

  it("can be engaged again once cleared", async () => {
    const halt = fileHalt(await home());
    await halt.engage();
    await halt.clear();

    assert.equal(await halt.engage(), true);
    assert.equal(await halt.engaged(), true);
  });

  it("is engaged only for the home it was engaged in", async () => {
    await fileHalt(await home()).engage();

    assert.equal(await fileHalt(await home()).engaged(), false);
  });
});

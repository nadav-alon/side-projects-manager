import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelName } from "../ports/index.ts";
import { FakeStore } from "./fake-store.ts";

describe("FakeStore model defaults", () => {
  it("has no default for any kind until a test names one", async () => {
    assert.deepEqual(await new FakeStore().loadModelDefaults(), {});
  });

  it("reads back the model defaults a test gave it", async () => {
    const store = new FakeStore();
    store.modelDefaults = { review: modelName("opus") };

    assert.deepEqual(await store.loadModelDefaults(), {
      review: modelName("opus"),
    });
  });
});

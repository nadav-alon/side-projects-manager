import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { fileTriggerLock } from "./file-trigger-lock.ts";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "trigger-lock-"));
}

describe("the file trigger lock", () => {
  it("claims a day it has not seen before", async () => {
    const lock = fileTriggerLock(await home());

    assert.equal(await lock.claim("2026-01-01"), true);
  });

  it("refuses a day already claimed, by the same instance", async () => {
    const lock = fileTriggerLock(await home());

    await lock.claim("2026-01-01");

    assert.equal(await lock.claim("2026-01-01"), false);
  });

  it("still claims a different day", async () => {
    const lock = fileTriggerLock(await home());

    await lock.claim("2026-01-01");

    assert.equal(await lock.claim("2026-01-02"), true);
  });

  it("survives being asked again from a fresh instance — a reboot", async () => {
    const directory = await home();
    await fileTriggerLock(directory).claim("2026-01-01");

    const rebooted = fileTriggerLock(directory);

    assert.equal(await rebooted.claim("2026-01-01"), false);
  });

  it("lets only one of two racing claims for the same day win", async () => {
    const lock = fileTriggerLock(await home());

    const [first, second] = await Promise.all([
      lock.claim("2026-01-01"),
      lock.claim("2026-01-01"),
    ]);

    assert.equal([first, second].filter(Boolean).length, 1);
  });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { tempHome } from "../testing/index.ts";
import { fileInvocationLease } from "./file-invocation-lease.ts";

const LEASE_FILE = "invocation.lease";

async function home(): Promise<string> {
  return tempHome("invocation-lease");
}

/** A pid guaranteed no longer alive: a child process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) {
    throw new Error("failed to spawn a child process for its pid");
  }
  return child.pid;
}

describe("the file invocation lease", () => {
  it("acquires when nothing holds it", async () => {
    const lease = fileInvocationLease(await home());

    assert.equal(await lease.acquire(), true);
  });

  it("refuses while held by a live process", async () => {
    const directory = await home();
    await fileInvocationLease(directory).acquire();

    const other = fileInvocationLease(directory);
    assert.equal(await other.acquire(), false);
  });

  it("takes over a lease whose holder's pid is dead", async () => {
    const directory = await home();
    // A lease left behind by a process that died mid-run: the file exists,
    // but nothing revives its pid.
    await writeFile(path.join(directory, LEASE_FILE), String(deadPid()));

    const lease = fileInvocationLease(directory);
    assert.equal(await lease.acquire(), true);
  });

  it("lets only one of two racing acquires win", async () => {
    const lease = fileInvocationLease(await home());

    const [first, second] = await Promise.all([
      lease.acquire(),
      lease.acquire(),
    ]);

    assert.equal([first, second].filter(Boolean).length, 1);
  });

  it("can be acquired again once released", async () => {
    const directory = await home();
    const lease = fileInvocationLease(directory);
    await lease.acquire();
    await lease.release();

    const other = fileInvocationLease(directory);
    assert.equal(await other.acquire(), true);
  });
});

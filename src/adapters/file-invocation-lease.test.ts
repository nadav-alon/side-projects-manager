import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { tempHome } from "../testing/index.ts";
import { fileInvocationLease } from "./file-invocation-lease.ts";

const LEASE_FILE = "invocation.lease";
const ADAPTER_URL = pathToFileURL(
  path.join(import.meta.dirname, "file-invocation-lease.ts"),
).href;

interface Racer {
  result: Promise<boolean>;
  kill: () => void;
}

/**
 * Acquires the lease at `directory` from a real child process, so two
 * concurrent acquires race across process boundaries rather than across
 * `Promise.all` within one event loop, where Node's own scheduling makes the
 * stale-takeover path uncontended.
 *
 * A winner keeps its process running rather than exiting the instant it
 * acquires: an invocation holds the lease for as long as it runs, and a
 * child that exits immediately would make the lease look stale again a
 * moment later — a false "two winners" the other racer would then be right
 * to produce, since by then the first is no longer really running.
 */
function acquireInChildProcess(directory: string): Racer {
  const script = `
    const { fileInvocationLease } = await import(${JSON.stringify(ADAPTER_URL)});
    const acquired = await fileInvocationLease(${JSON.stringify(directory)}).acquire();
    process.stdout.write(acquired ? "true\\n" : "false\\n");
    if (acquired) {
      setInterval(() => {}, 1 << 30);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
  const lines = readline.createInterface({ input: child.stdout });
  const result = new Promise<boolean>((resolve) => {
    lines.once("line", (line) => resolve(line.trim() === "true"));
  });
  return { result, kill: () => child.kill() };
}

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

  it("lets only one of two real processes win a race over a stale lease", async () => {
    for (let trial = 0; trial < 10; trial += 1) {
      const directory = await home();
      await writeFile(path.join(directory, LEASE_FILE), String(deadPid()));

      const a = acquireInChildProcess(directory);
      const b = acquireInChildProcess(directory);
      try {
        const results = await Promise.all([a.result, b.result]);
        assert.equal(
          results.filter(Boolean).length,
          1,
          `trial ${trial}: expected exactly one winner, got ${JSON.stringify(results)}`,
        );
      } finally {
        a.kill();
        b.kill();
      }
    }
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

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "status.ts");

async function run(home: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  });
}

async function writeJournal(home: string, journal: unknown): Promise<void> {
  await writeFile(
    path.join(home, "journal.json"),
    JSON.stringify(journal),
  );
}

async function writeState(home: string, state: unknown): Promise<void> {
  await writeFile(path.join(home, "state.json"), JSON.stringify(state));
}

/** A pid guaranteed no longer alive: a child process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) {
    throw new Error("failed to spawn a child process for its pid");
  }
  return child.pid;
}

describe("the status command", () => {
  it("reports that nothing has ever run on a fresh checkout", async () => {
    const { stdout, stderr } = await run(await tempHome("status-bin"));

    assert.equal(stderr, "");
    assert.match(stdout, /No invocation has ever run/);
  });

  it("reports today claimed from the state document", async () => {
    const home = await tempHome("status-bin");
    const today = new Date().toISOString().slice(0, 10);
    await writeJournal(home, {
      records: [
        {
          openedAt: new Date().toISOString(),
          process: 1234,
          closedAt: new Date().toISOString(),
          outcome: "dry-queue",
          projects: [],
        },
      ],
    });
    await writeState(home, { projects: {}, announcedOn: today });

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /is claimed/);
  });

  it("reports a record in flight whose process has died", async () => {
    const home = await tempHome("status-bin");
    await writeJournal(home, {
      records: [{ openedAt: new Date().toISOString(), process: deadPid() }],
    });

    const { stdout } = await run(home);

    assert.match(stdout, /died without closing its record/);
  });

  it("reports a record in flight whose process is still running", async () => {
    const home = await tempHome("status-bin");
    await writeJournal(home, {
      records: [{ openedAt: new Date().toISOString(), process: process.pid }],
    });

    const { stdout } = await run(home);

    assert.match(stdout, /is still running/);
  });

  it("makes no network call and writes nothing back to the manager home", async () => {
    const home = await tempHome("status-bin");
    await writeJournal(home, {
      records: [
        {
          openedAt: new Date().toISOString(),
          process: 1234,
          closedAt: new Date().toISOString(),
          outcome: "dry-queue",
          projects: [],
        },
      ],
    });

    const before = await readFile(path.join(home, "journal.json"), "utf8");
    await run(home);
    const after = await readFile(path.join(home, "journal.json"), "utf8");

    assert.equal(before, after);
  });
});

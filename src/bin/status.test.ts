import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { localDay } from "../ports/index.ts";
import { deadPid, fakeCrontabBin, tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "status.ts");

const CRON_MARKER =
  "# side-projects-manager: hourly schedule (see scripts/install-triggers.sh)";

function cronLine(home: string): string {
  return `0 * * * * /usr/bin/node "${home}/src/bin/morning-run.ts" >> "${home}/trigger.log" 2>&1 ${CRON_MARKER}`;
}

/**
 * Runs the status command against `home`, with the crontab and the rc files
 * stubbed so the report is deterministic regardless of what is actually
 * registered on the machine running the test. `crontabLines`, when given,
 * stands in for the developer's own crontab; left out, the command sees none.
 */
async function run(
  home: string,
  crontabLines?: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const bin = await fakeCrontabBin(crontabLines);
  const noRcFiles = await tempHome("status-bin-home");
  return execFileAsync(process.execPath, [entryPoint], {
    env: {
      ...process.env,
      SIDE_PROJECTS_MANAGER_HOME: home,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: noRcFiles,
    },
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

/** Every file directly under `home` and its contents, for comparing before and after a run. */
async function snapshotHome(home: string): Promise<Record<string, string>> {
  const entries = await readdir(home);
  const files: Record<string, string> = {};
  for (const entry of entries) {
    files[entry] = await readFile(path.join(home, entry), "utf8");
  }
  return files;
}

describe("the status command", () => {
  it("reports that nothing has ever run on a fresh checkout", async () => {
    const { stdout, stderr } = await run(await tempHome("status-bin"));

    assert.equal(stderr, "");
    assert.match(stdout, /No invocation has ever run/);
  });

  it("reports today claimed from the state document", async () => {
    const home = await tempHome("status-bin");
    const today = localDay(new Date());
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

  it("writes nothing back to the manager home, and creates no file there", async () => {
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

    const before = await snapshotHome(home);
    await run(home);
    const after = await snapshotHome(home);

    assert.deepEqual(after, before);
  });

  it("reaches for no port that could make a network call", async () => {
    const source = await readFile(entryPoint, "utf8");

    assert.doesNotMatch(source, /tracker|repo-host|repoHost/i);
  });

  it("reports the schedule not registered when the crontab carries no marker", async () => {
    const { stdout } = await run(await tempHome("status-bin"));

    assert.match(stdout, /Schedule: not registered/);
    assert.match(stdout, /npm run triggers:install/);
  });

  it("reports the schedule armed when the crontab points at this manager home", async () => {
    const home = await tempHome("status-bin");

    const { stdout } = await run(home, [cronLine(home)]);

    assert.match(stdout, /Schedule: armed, firing every hour at :00\./);
  });

  it("reports the schedule as a problem when the crontab points at a different manager home", async () => {
    const home = await tempHome("status-bin");
    const moved = await tempHome("status-bin-moved");

    const { stdout } = await run(home, [cronLine(moved)]);

    assert.match(stdout, new RegExp(`pointing at ${moved.replaceAll("/", "\\/")}`));
    assert.match(stdout, /npm run triggers:install/);
  });

  it("reports the logon guard not registered as expected rather than as a problem", async () => {
    const { stdout } = await run(await tempHome("status-bin"));

    assert.match(stdout, /Logon guard: not registered/);
  });
});

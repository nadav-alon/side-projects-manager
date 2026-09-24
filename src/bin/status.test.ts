import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { CHECKOUT_ROOT } from "../adapters/manager-home.ts";
import { localDay } from "../ports/index.ts";
import { cronLine, crontabStubBin, deadPid, tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "status.ts");

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
  const bin = await crontabStubBin(crontabLines);
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

async function writeBudget(home: string, budget: unknown): Promise<void> {
  await writeFile(path.join(home, "budget.json"), JSON.stringify(budget));
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

  it("names a run in progress and its agent's recent steps, read off its own transcript", async () => {
    const home = await tempHome("status-bin");
    const transcriptDirectory = await tempHome("status-bin-transcript");
    const projectDir = path.join(transcriptDirectory, "pilot");
    await mkdir(projectDir);
    await writeFile(
      path.join(projectDir, "session.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Reading the ticket." }] },
      })}\n`,
    );
    await writeJournal(home, {
      records: [
        {
          openedAt: new Date().toISOString(),
          process: process.pid,
          runs: [
            {
              kind: "implementation",
              repo: "nadav-alon/pilot",
              number: 7,
              startedAt: new Date().toISOString(),
              transcriptDirectory,
            },
          ],
        },
      ],
    });

    const { stdout } = await run(home);

    assert.match(stdout, /implementation nadav-alon\/pilot #7/);
    assert.match(stdout, /Reading the ticket\./);
  });

  it("says a run's transcript is not readable yet, instead of failing, when its directory holds none", async () => {
    const home = await tempHome("status-bin");
    const transcriptDirectory = await tempHome("status-bin-transcript");
    await writeJournal(home, {
      records: [
        {
          openedAt: new Date().toISOString(),
          process: process.pid,
          runs: [
            {
              kind: "review",
              repo: "nadav-alon/pilot",
              number: 9,
              startedAt: new Date().toISOString(),
              transcriptDirectory,
            },
          ],
        },
      ],
    });

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /Transcript not readable yet/);
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

  it("reports the schedule armed when the crontab points at this checkout, even with SIDE_PROJECTS_MANAGER_HOME set elsewhere", async () => {
    // install-triggers.sh always roots the cron line at its own checkout
    // (REPO_DIR) — never at SIDE_PROJECTS_MANAGER_HOME, which only relocates
    // where the registry and state document live. `run` below always sets
    // that variable to a tempHome distinct from CHECKOUT_ROOT, so this is
    // exactly that case, not just the common one.
    const home = await tempHome("status-bin");

    const { stdout } = await run(home, [cronLine(CHECKOUT_ROOT)]);

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

  it("reports each window's spend against the developer's own budget document", async () => {
    const home = await tempHome("status-bin");
    await writeBudget(home, { weeklyAllowance: 1_000, reserveFraction: 0 });

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /^Five-hour window: .* tokens \([\d.]+%\)/m);
    assert.match(stdout, /^Weekly window: 0 of 1,000 tokens \(0\.0%\)/m);
  });

  it("counts a run the state document records toward the window it falls in, as the gate itself would", async () => {
    const home = await tempHome("status-bin");
    await writeBudget(home, { weeklyAllowance: 1_000, reserveFraction: 0 });
    const now = new Date();
    await writeState(home, {
      projects: { "nadav-alon/pilot": { runs: [{ at: now.toISOString(), tokensUsed: 400 }] } },
    });

    const { stdout } = await run(home);

    assert.match(
      stdout,
      /^Weekly window: 400 of 1,000 tokens \(40\.0%\) — loop spent 400, developer spent 0\./m,
    );
  });

  it("says the reserve is already reached once the window's own spend passes it", async () => {
    const home = await tempHome("status-bin");
    await writeBudget(home, { weeklyAllowance: 1_000, reserveFraction: 0 });
    const now = new Date();
    await writeState(home, {
      projects: { "nadav-alon/pilot": { runs: [{ at: now.toISOString(), tokensUsed: 1_001 }] } },
    });

    const { stdout } = await run(home);

    assert.match(
      stdout,
      /^Weekly window:.*reserve is already reached: the gate would refuse a run now\./m,
    );
  });
});

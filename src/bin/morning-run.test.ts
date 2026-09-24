import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { fileHalt } from "../adapters/file-halt.ts";
import {
  fileInvocationLease,
  LEASE_FILE,
} from "../adapters/file-invocation-lease.ts";
import { localDay } from "../ports/index.ts";
import {
  callWith,
  deadPid,
  emptyBacklogGh,
  recordingGh,
  type RecordedGh,
} from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "morning-run.ts");

/**
 * The command against its own manager home, so the suite reads and writes
 * documents in a temporary directory rather than the developer's checkout.
 */
async function run(home: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  });
}

/**
 * Puts a `docker` on PATH that kills whatever ran it with `signal`, for the
 * length of the test.
 *
 * The loop process inspects the sandbox image before it opens its journal
 * record, so this ends the real loop exactly where one that never got as far
 * as reporting itself ends: nothing in the journal, and nobody but the
 * trigger that spawned it left to say so.
 */
async function loopKilledBeforeItRecords(
  t: { after: (fn: () => void) => void },
  signal: NodeJS.Signals,
): Promise<void> {
  const previous = process.env["PATH"];
  const bin = await mkdtemp(path.join(tmpdir(), "docker-killing-"));
  await writeFile(
    path.join(bin, "docker"),
    // Named without its `SIG` prefix, which is what a POSIX shell takes.
    `#!/bin/sh\nkill -s ${signal.replace("SIG", "")} "$PPID"\n`,
    { mode: 0o755 },
  );
  process.env["PATH"] = `${bin}:${previous ?? ""}`;
  t.after(() => {
    process.env["PATH"] = previous;
  });
}

/**
 * Runs the command with the loop it spawns killed by `signal` before it can
 * record anything. Settles rather than rejects even on a non-zero exit, so a
 * test can read the exit code back without unpacking an error.
 */
async function runWithBrokenLoop(
  t: { after: (fn: () => void) => void },
  directory: string,
  signal: NodeJS.Signals,
): Promise<{ stdout: string; stderr: string; code: number }> {
  await loopKilledBeforeItRecords(t, signal);
  return run(directory).then(
    (result) => ({ ...result, code: 0 }),
    (error: { stdout: string; stderr: string; code: number }) => error,
  );
}

async function journal(directory: string): Promise<{ records: unknown[] }> {
  return JSON.parse(
    await readFile(path.join(directory, "journal.json"), "utf8"),
  );
}

async function home(registry?: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "morning-run-bin-"));
  if (registry !== undefined) {
    await writeFile(
      path.join(directory, "registry.json"),
      JSON.stringify(registry),
    );
  }
  return directory;
}

describe("the morning-run command", () => {
  describe("the invocation lease", () => {
    it("refuses, without running the loop, while a live invocation holds the lease", async (t) => {
      const gh = await emptyBacklogGh(t);
      const directory = await home();
      const held = fileInvocationLease(directory);
      await held.acquire();

      const { stdout } = await run(directory);

      assert.match(stdout, /already running/i);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 0, "the held invocation never ran");
      // A day that was not claimed still runs nothing and records nothing: no
      // journal document was ever written for it.
      await assert.rejects(readFile(path.join(directory, "journal.json")));
    });

    it("runs again once an earlier invocation has released the lease", async (t) => {
      await emptyBacklogGh(t);
      const directory = await home();

      await run(directory);
      const { stdout } = await run(directory);

      assert.doesNotMatch(
        stdout,
        /already running/i,
        "the lease was released",
      );
      assert.match(stdout, /nothing to do/i);
    });

    it("is not blocked by a lease a dead process left behind", async (t) => {
      const gh = await emptyBacklogGh(t);
      const directory = await home();
      await writeFile(path.join(directory, LEASE_FILE), String(deadPid()));

      const { stdout } = await run(directory);

      assert.doesNotMatch(stdout, /already running/i);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 1, "the invocation went ahead");
    });

    it("still runs for a manager home it hasn't seen before", async (t) => {
      const gh = await emptyBacklogGh(t);

      await run(await home());
      await run(await home());

      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 2, "each home has its own lease");
    });
  });

  describe("halted", () => {
    it("runs nothing, takes no lease, and says the loop is halted", async (t) => {
      const gh = await emptyBacklogGh(t);
      const directory = await home();
      await fileHalt(directory).engage();

      const { stdout, stderr } = await run(directory);

      assert.equal(stderr, "");
      assert.match(stdout, /halted/i);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 0, "the halted firing never ran");
      await assert.rejects(access(path.join(directory, LEASE_FILE)), "no lease was taken");
    });

    it("claims no day: writes neither a journal record nor a state document", async (t) => {
      await emptyBacklogGh(t);
      const directory = await home();
      await fileHalt(directory).engage();

      await run(directory);

      await assert.rejects(readFile(path.join(directory, "journal.json")));
      await assert.rejects(readFile(path.join(directory, "state.json")));
    });

    it("runs again once resumed", async (t) => {
      const gh = await emptyBacklogGh(t);
      const directory = await home();
      const halt = fileHalt(directory);
      await halt.engage();
      await halt.clear();

      const { stdout } = await run(directory);

      assert.doesNotMatch(stdout, /halted/i);
      assert.match(stdout, /nothing to do/i);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 1, "the invocation went ahead");
    });
  });

  it("exits successfully and says there was nothing to do", async (t) => {
    await emptyBacklogGh(t);

    const { stdout, stderr } = await run(await home());

    assert.equal(stderr, "");
    assert.match(stdout, /nothing to do/i);
  });

  it("reports the registered projects it skipped, and why", async (t) => {
    await emptyBacklogGh(t);

    const directory = await home({
      projects: [
        { repo: "nadav-alon/pilot", paused: true },
        { repo: "octocat/Hello-World" },
      ],
    });

    const { stdout } = await run(directory);

    assert.match(stdout, /nadav-alon\/pilot \(paused\)/);
    assert.match(
      stdout,
      /octocat\/Hello-World \(no ready-for-agent tickets\)/,
    );
  });

  it("leaves a state document behind for the next morning", async (t) => {
    await emptyBacklogGh(t);

    const directory = await home();

    await run(directory);

    const state = await readFile(path.join(directory, "state.json"), "utf8");
    // A dry queue, and today not yet announced, so the summary published and
    // recorded today's local day.
    assert.deepEqual(JSON.parse(state), {
      projects: {},
      announcedOn: localDay(new Date()),
    });
  });

  it("reports a broken registry in one line, and still publishes a summary", async (t) => {
    const gh = await emptyBacklogGh(t);

    const directory = await home({ projects: [{ repo: "pilot" }] });

    const { stdout, stderr, code } = await run(directory).then(
      (result) => ({ ...result, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );

    assert.equal(stderr, "");
    assert.equal(code, 1);
    assert.match(stdout, /registry\.json.*"pilot"/);
    assert.doesNotMatch(stdout, /\n\s+at /);

    const calls = await gh.calls();
    assert.equal(
      calls.filter((call) => call[0] === "issue" && call[1] === "create")
        .length,
      1,
      "a summary issue is still published",
    );
  });

  it("publishes exactly one summary issue in the manager repo", async (t) => {
    const gh = await emptyBacklogGh(t);

    await run(await home());

    const calls = await gh.calls();
    const creates = calls.filter(
      (call) => call[0] === "issue" && call[1] === "create",
    );
    assert.equal(creates.length, 1, "exactly one summary issue is created");
    assert.ok(callWith(calls, "issue", "create", "--title"));
  });

  it("leaves a closed journal record behind, naming this process", async (t) => {
    await emptyBacklogGh(t);

    const directory = await home();

    await run(directory);

    const journal = JSON.parse(
      await readFile(path.join(directory, "journal.json"), "utf8"),
    );
    // One record and not two: the loop opened its own, so nothing extra is
    // recorded for it having never reported.
    assert.equal(journal.records.length, 1);
    const [record] = journal.records;
    assert.equal(typeof record.process, "number");
    assert.equal(record.outcome, "dry-queue");
    assert.deepEqual(record.projects, []);
    assert.ok(new Date(record.openedAt).getTime() <= new Date(record.closedAt).getTime());
  });

  it("records a closed invocation even when the loop itself broke", async (t) => {
    await emptyBacklogGh(t);

    const directory = await home({ projects: [{ repo: "pilot" }] });

    await run(directory).catch(() => {});

    const journal = JSON.parse(
      await readFile(path.join(directory, "journal.json"), "utf8"),
    );
    assert.equal(journal.records[0]?.outcome, "invocation-failed");
  });

  it("names where a published summary landed in the journal record", async (t) => {
    await emptyBacklogGh(t);

    const directory = await home();

    await run(directory);

    const journal = JSON.parse(
      await readFile(path.join(directory, "journal.json"), "utf8"),
    );
    assert.equal(
      journal.records[0]?.summaryLocation,
      "https://github.com/nadav-alon/side-projects-manager/issues/0",
    );
  });

  it("keeps a summary that could not be published, readable in the manager home, and names it in the journal record", async (t) => {
    const directory = await home();
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue list") echo "[]" ;;`,
        `  "issue create") echo "gh: rate limited" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const { stdout, code } = await run(directory).then(
      (result) => ({ ...result, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );

    // A summary that cannot be published is not itself an infrastructure
    // failure, but it still joins the exit codes that already say so.
    assert.equal(code, 1);
    assert.match(stdout, /nothing to do/i);
    assert.match(stdout, /summary issue could not be published/);

    const kept = (await readdir(directory)).find((file) =>
      /^summary-.*\.txt$/.test(file),
    );
    assert.ok(kept, "the composed summary is kept in the manager home");
    const body = await readFile(path.join(directory, kept as string), "utf8");
    assert.match(body, /nothing to do/i);

    const journal = JSON.parse(
      await readFile(path.join(directory, "journal.json"), "utf8"),
    );
    const [record] = journal.records;
    assert.match(record.summaryFailure.reason, /rate limited/);
    assert.equal(
      record.summaryFailure.keptAt,
      path.join(directory, kept as string),
    );
    assert.equal(record.summaryLocation, undefined);
  });

  it("says on stderr, and does not change the exit code, when the composed summary cannot be kept", async (t) => {
    const directory = await home();
    // Blocks exactly the write `keepSummary` makes: a directory sitting
    // where its pending file wants to land forces that one write to fail
    // without touching the state or journal writes made around it — the
    // same trick the journal-close test below plays on `journal.json.pending`.
    await mkdir(path.join(directory, "summary.txt.pending"));
    await recordingGh(
      t,
      [
        `case "$1 $2" in`,
        `  "issue list") echo "[]" ;;`,
        `  "issue create") echo "gh: rate limited" >&2; exit 1 ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const { stdout, stderr, code } = await run(directory).then(
      (result) => ({ ...result, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );

    // Still 1, the same as the publish failure alone already set: keeping
    // the summary failing too must not cost the invocation a second time.
    assert.equal(code, 1);
    assert.match(stdout, /summary issue could not be published/);
    assert.match(stderr, /summary could not be kept/);

    const journal = JSON.parse(
      await readFile(path.join(directory, "journal.json"), "utf8"),
    );
    const [record] = journal.records;
    assert.match(record.summaryFailure.reason, /rate limited/);
    assert.equal(record.summaryFailure.keptAt, undefined);
  });

  it("keeps running, and says nothing but stderr, when the journal cannot be written", async (t) => {
    await emptyBacklogGh(t);

    const directory = await home();
    // A file where the journal expects to write a directory forces every
    // journal write to fail, without touching anything the loop itself reads.
    await mkdir(path.join(directory, "journal.json"));

    const { stdout, stderr } = await run(directory);

    assert.match(stdout, /nothing to do/i);
    assert.match(stderr, /journal/i);
  });

  it("keeps running, leaves the record open, and says nothing but stderr, when the journal cannot be closed", async (t) => {
    const directory = await home();

    // The journal writes through `journal.json.pending`, renamed over
    // `journal.json` once written. Opening the record uses and frees that
    // path before the loop ever calls `gh`, so blocking it there — the
    // first moment this test controls after the open has already
    // succeeded — fails only the close.
    const pending = path.join(directory, "journal.json.pending");
    await recordingGh(
      t,
      [
        `mkdir -p "${pending}"`,
        `case "$1 $2" in`,
        `  "issue list") echo "[]" ;;`,
        `  "issue create") echo "https://github.com/nadav-alon/side-projects-manager/issues/0" ;;`,
        `  *) : ;;`,
        `esac`,
      ].join("\n"),
    );

    const { stdout, stderr } = await run(directory);

    assert.match(stdout, /nothing to do/i);
    assert.match(stderr, /journal/i);

    const journal = JSON.parse(
      await readFile(path.join(directory, "journal.json"), "utf8"),
    );
    assert.equal(journal.records.length, 1);
    assert.equal(journal.records[0].closedAt, undefined);
  });

  it("records that the loop never reported when its process leaves no journal record", async (t) => {
    const directory = await home();

    const { code } = await runWithBrokenLoop(t, directory, "SIGKILL");

    // 128 plus the signal that ended it, as a shell reports it.
    assert.equal(code, 137, "the loop's own exit code is passed through");
    const { records } = await journal(directory);
    assert.equal(records.length, 1);
    const [record] = records as [
      {
        outcome: string;
        exitCode: number;
        openedAt: string;
        closedAt: string;
        projects: unknown[];
      },
    ];
    assert.equal(record.outcome, "never-reported");
    assert.equal(record.exitCode, 137);
    assert.deepEqual(record.projects, []);
    assert.ok(
      new Date(record.openedAt).getTime() <=
        new Date(record.closedAt).getTime(),
    );
  });

  it("says on stderr, and leaves the exit code alone, when the never-reported record cannot be written", async (t) => {
    const directory = await home();
    // A file where the journal expects to write a directory forces every
    // journal write to fail.
    await mkdir(path.join(directory, "journal.json"));

    const { stderr, code } = await runWithBrokenLoop(t, directory, "SIGTERM");

    assert.equal(
      code,
      143,
      "the exit code is unaffected by the journal write failing",
    );
    assert.match(stderr, /journal could not be read/i);
  });

  describe("interrupted", () => {
    /**
     * A `gh` whose backlog listing takes two seconds, touching `marker` as it
     * starts: long enough to interrupt a morning with something in progress.
     */
    async function slowListingGh(
      t: { after: (fn: () => void) => void },
      marker: string,
    ): Promise<RecordedGh> {
      return recordingGh(
        t,
        [
          `case "$1 $2" in`,
          `  "issue list") touch "${marker}"; sleep 2; echo "[]" ;;`,
          `  "issue create") echo "https://github.com/nadav-alon/side-projects-manager/issues/0" ;;`,
          `  *) : ;;`,
          `esac`,
        ].join("\n"),
      );
    }

    /**
     * The command in a process group of its own, as a terminal starts it, so
     * `interrupt` can signal that whole group the way Ctrl+C does.
     */
    function start(directory: string) {
      const child = spawn(process.execPath, [entryPoint], {
        env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: directory },
        detached: true,
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const closed = new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
      });
      const signal = (name: NodeJS.Signals) =>
        process.kill(-(child.pid as number), name);
      return {
        interrupt: () => signal("SIGINT"),
        signal,
        stdout: () => stdout,
        stderr: () => stderr,
        closed,
      };
    }

    async function until(condition: () => boolean | Promise<boolean>) {
      while (!(await condition())) {
        await sleep(20);
      }
    }

    async function interruptedMidListing(
      t: { after: (fn: () => void) => void },
      signal: NodeJS.Signals = "SIGINT",
    ) {
      const marker = path.join(await home(), "listing");
      const gh = await slowListingGh(t, marker);
      const morning = start(
        await home({ projects: [{ repo: "octocat/Hello-World" }] }),
      );
      await until(() => access(marker).then(() => true, () => false));
      morning.signal(signal);
      return { gh, morning };
    }

    it("lets what is in progress finish, and still publishes the summary", async (t) => {
      const { gh, morning } = await interruptedMidListing(t);

      const code = await morning.closed;

      // The listing in progress was not killed by the interrupt: had it been,
      // the invocation would have failed and exited non-zero.
      assert.equal(code, 0);
      assert.match(morning.stderr(), /Stopping/);
      assert.match(morning.stdout(), /no ready-for-agent tickets/);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 1, "the summary is still published");
    });

    it("stops at once on a second interrupt, publishing nothing", async (t) => {
      const { gh, morning } = await interruptedMidListing(t);
      await until(() => /Stopping/.test(morning.stderr()));
      morning.interrupt();

      const code = await morning.closed;

      assert.equal(code, 130);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 0);
    });

    it("says on stderr, before it kills anything, what a second interrupt is abandoning", async (t) => {
      const { morning } = await interruptedMidListing(t);
      await until(() => /Stopping/.test(morning.stderr()));
      morning.interrupt();

      await morning.closed;

      // Nothing had started a container yet — the listing itself was still
      // in progress — so there is nothing to name, but the line is said all
      // the same: a developer relying on it to know what was left behind
      // must be able to trust it appears every time, not only when
      // something was actually running.
      assert.match(morning.stderr(), /Stopping now/);
      assert.doesNotMatch(morning.stdout(), /Stopping now/);
    });

    it("stops as a first interrupt does when its terminal hangs up", async (t) => {
      const { gh, morning } = await interruptedMidListing(t, "SIGHUP");

      const code = await morning.closed;

      assert.equal(code, 0);
      assert.match(morning.stderr(), /Stopping/);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 1, "the summary is still published");
    });

    it("stops as a first interrupt does when the process shielding it is killed", async (t) => {
      const { gh, morning } = await interruptedMidListing(t, "SIGKILL");

      // Closed only once the loop, which shares the output pipe, has ended too.
      await morning.closed;

      assert.match(morning.stderr(), /Stopping/);
      assert.match(morning.stdout(), /no ready-for-agent tickets/);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 1, "the summary is still published");
    });
  });
});

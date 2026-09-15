import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { localDay } from "../ports/index.ts";
import {
  callWith,
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
      const closed = new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
      });
      return {
        interrupt: () => process.kill(-(child.pid as number), "SIGINT"),
        stdout: () => stdout,
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
    ) {
      const marker = path.join(await home(), "listing");
      const gh = await slowListingGh(t, marker);
      const morning = start(
        await home({ projects: [{ repo: "octocat/Hello-World" }] }),
      );
      await until(() => access(marker).then(() => true, () => false));
      morning.interrupt();
      return { gh, morning };
    }

    it("lets what is in progress finish, and still publishes the summary", async (t) => {
      const { gh, morning } = await interruptedMidListing(t);

      const code = await morning.closed;

      // The listing in progress was not killed by the interrupt: had it been,
      // the invocation would have failed and exited non-zero.
      assert.equal(code, 0);
      assert.match(morning.stdout(), /Stopping/);
      assert.match(morning.stdout(), /no ready-for-agent tickets/);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 1, "the summary is still published");
    });

    it("stops at once on a second interrupt, publishing nothing", async (t) => {
      const { gh, morning } = await interruptedMidListing(t);
      await until(() => /Stopping/.test(morning.stdout()));
      morning.interrupt();

      const code = await morning.closed;

      assert.equal(code, 130);
      const creates = (await gh.calls()).filter(
        (call) => call[0] === "issue" && call[1] === "create",
      );
      assert.equal(creates.length, 0);
    });
  });
});

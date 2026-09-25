import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { fileHalt } from "../adapters/file-halt.ts";
import { isProcessAlive } from "../adapters/process-alive.ts";
import { processId, type ProcessId } from "../ports/index.ts";
import { deadPid, tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "stop.ts");

async function run(
  home: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint, ...args], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  });
}

async function writeJournal(home: string, journal: unknown): Promise<void> {
  await writeFile(path.join(home, "journal.json"), JSON.stringify(journal));
}

/**
 * A running process that appends `SIGINT\n` to `marker` every time it is
 * interrupted, and exits with 130 once it has been interrupted twice —
 * standing in for `stopOnInterrupt` (`src/bin/morning-run.ts`) without
 * running the loop for real. Resolves once it has told stdout it is
 * listening, so a test never signals it before its handler is registered.
 */
async function signalEchoingProcess(
  marker: string,
): Promise<{ pid: ProcessId; child: ChildProcess }> {
  const script = [
    "const fs = require('node:fs');",
    "let count = 0;",
    "process.on('SIGINT', () => {",
    "  count += 1;",
    "  fs.appendFileSync(process.env['MARKER'], 'SIGINT\\n');",
    "  if (count >= 2) process.exit(130);",
    "});",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, MARKER: marker },
  });
  await new Promise<void>((resolve) => {
    child.stdout?.once("data", () => resolve());
  });
  return { pid: processId(child.pid as number), child };
}

/** Every line `signalEchoingProcess` has appended to `marker` so far. */
async function markerLines(marker: string): Promise<string[]> {
  const text = await readFile(marker, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

describe("the stop command", () => {
  it("halts the loop, and says so, when nothing was in progress", async () => {
    const home = await tempHome("stop-bin");

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /Halted/);
    assert.match(stdout, /No run was in progress/);
    assert.equal(await fileHalt(home).engaged(), true);
  });

  it("is idempotent about the halt, and still says no run was in progress", async () => {
    const home = await tempHome("stop-bin");
    await fileHalt(home).engage();

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /already halted/i);
    assert.match(stdout, /No run was in progress/);
  });

  it("signals the in-flight invocation's process, found through the journal, once", async (t) => {
    const home = await tempHome("stop-bin");
    const marker = path.join(home, "marker");
    const { pid, child } = await signalEchoingProcess(marker);
    t.after(() => child.kill("SIGKILL"));
    await writeJournal(home, {
      records: [{ openedAt: new Date().toISOString(), process: pid }],
    });

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /Stopping/);
    assert.deepEqual(await markerLines(marker), ["SIGINT"]);
    assert.equal(
      isProcessAlive(pid),
      true,
      "a single signal is not the abandon-in-progress-work one",
    );
  });

  it("says no run was in progress when the only in-flight record's process is gone, rather than failing", async () => {
    const home = await tempHome("stop-bin");
    await writeJournal(home, {
      records: [{ openedAt: new Date().toISOString(), process: deadPid() }],
    });

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /No run was in progress/);
  });

  it("never signals a journal record whose process is gone", async (t) => {
    const home = await tempHome("stop-bin");
    const marker = path.join(home, "marker");
    const { pid, child } = await signalEchoingProcess(marker);
    t.after(() => child.kill("SIGKILL"));
    await writeJournal(home, {
      records: [
        { openedAt: new Date().toISOString(), process: deadPid() },
        { openedAt: new Date().toISOString(), process: pid },
      ],
    });

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /Stopping/);
    assert.deepEqual(
      await markerLines(marker),
      ["SIGINT"],
      "only the record whose process is alive is signalled",
    );
  });

  it("--now signals twice, abandoning the run in progress as a second Ctrl+C does", async (t) => {
    const home = await tempHome("stop-bin");
    const marker = path.join(home, "marker");
    const { pid, child } = await signalEchoingProcess(marker);
    t.after(() => child.kill("SIGKILL"));
    await writeJournal(home, {
      records: [{ openedAt: new Date().toISOString(), process: pid }],
    });

    const [{ stdout, stderr }, exitCode] = await Promise.all([
      run(home, ["--now"]),
      new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      }),
    ]);

    assert.equal(stderr, "");
    assert.match(stdout, /Stopping now/);
    assert.equal(exitCode, 130, "abandoned exactly as a second Ctrl+C would");
    assert.deepEqual(await markerLines(marker), ["SIGINT", "SIGINT"]);
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { tempHome } from "./testing/index.ts";

const script = path.resolve(import.meta.dirname, "..", "scripts", "status-line.ts");

const ESC = "\u001b";
const input = (sessionName?: string) =>
  JSON.stringify({
    ...(sessionName !== undefined && { session_name: sessionName }),
    cwd: "/nowhere/pilot",
    model: { display_name: "Opus" },
    cost: { total_cost_usd: 1.234 },
  });

function render(home: string, stdin: string): string {
  return execFileSync(process.execPath, [script], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  }).trimEnd();
}

async function writeJournal(home: string, records: unknown[]): Promise<void> {
  await writeFile(path.join(home, "journal.json"), JSON.stringify({ records }));
}

describe("the status line", () => {
  for (const [mode, colour] of [
    ["grill", "35"],
    ["standup", "36"],
    ["triage", "33"],
    ["wayfinder", "32"],
  ] as const) {
    it(`badges a ${mode} session in colour ${colour}`, async () => {
      const line = render(await tempHome("status-line"), input(`${mode}: owner/pilot#4`));

      assert.equal(line, `${ESC}[${colour}m${mode}${ESC}[0m pilot Opus $1.23`);
    });
  }

  it("shows no badge for an untitled session", async () => {
    assert.equal(render(await tempHome("status-line"), input()), "pilot Opus $1.23");
  });

  it("appends halted when the halt file exists", async () => {
    const home = await tempHome("status-line");
    await writeFile(path.join(home, "halt"), "");

    assert.equal(render(home, input()), "pilot Opus $1.23 halted");
  });

  it("names the in-flight run and its minutes", async () => {
    const home = await tempHome("status-line");
    await writeJournal(home, [
      { openedAt: "2026-01-01T00:00:00.000Z", process: 1, closedAt: "2026-01-01T00:05:00.000Z" },
      {
        openedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
        process: 2,
        runs: [
          {
            kind: "work",
            repo: "owner/pilot",
            number: 7,
            startedAt: new Date(Date.now() - 40 * 60_000 - 5_000).toISOString(),
          },
        ],
      },
    ]);

    assert.equal(render(home, input()), "pilot Opus $1.23 in flight: owner/pilot#7 (40 min)");
  });

  it("is idle when every record is closed", async () => {
    const home = await tempHome("status-line");
    await writeJournal(home, [
      { openedAt: "2026-01-01T00:00:00.000Z", process: 1, closedAt: "2026-01-01T00:05:00.000Z" },
    ]);

    assert.equal(render(home, input()), "pilot Opus $1.23");
  });

  it("leaves the loop part blank when the home does not exist", async () => {
    const home = path.join(await tempHome("status-line"), "missing");

    assert.equal(render(home, input()), "pilot Opus $1.23");
  });

  it("leaves the loop part blank when the journal will not parse", async () => {
    const home = await tempHome("status-line");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "journal.json"), "{ not json");

    assert.equal(render(home, input()), "pilot Opus $1.23");
  });
});

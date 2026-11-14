import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "drop-discovery.ts");

describe("the drop-discovery command", () => {
  it("drops every discovery on the ticket from recorded-discoveries.json and keeps the rest", async () => {
    const home = await tempHome("drop-discovery-bin");
    const file = path.join(home, "recorded-discoveries.json");
    const entry = (number: number, title: string) => ({
      repo: "nadav-alon/pilot",
      number,
      kind: "suggestion",
      title,
      filedAt: "2026-01-01T09:00:00.000Z",
    });
    await writeFile(file, JSON.stringify({ discoveries: [entry(7, "One"), entry(8, "Other"), entry(7, "Two")] }));

    const { stdout } = await execFileAsync(process.execPath, [entryPoint, "nadav-alon/pilot#7"], {
      env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
    });

    assert.match(stdout, /Dropped 2 recorded discoveries on nadav-alon\/pilot#7/);
    const kept = (JSON.parse(await readFile(file, "utf8")) as { discoveries: { title: string }[] }).discoveries;
    assert.deepEqual(kept.map(({ title }) => title), ["Other"]);
  });

  it("exits 0 for a ticket with no recorded discovery", async () => {
    const home = await tempHome("drop-discovery-bin");

    const { stdout } = await execFileAsync(process.execPath, [entryPoint, "nadav-alon/pilot#7"], {
      env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
    });

    assert.match(stdout, /Dropped 0 recorded discoveries/);
  });

  it("exits nonzero naming the expected form for a malformed reference", async () => {
    const home = await tempHome("drop-discovery-bin");

    await assert.rejects(
      execFileAsync(process.execPath, [entryPoint, "pilot-7"], {
        env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
      }),
      (error: { code?: number; stderr?: string }) => error.code !== 0 && /owner\/repo#n/.test(error.stderr ?? ""),
    );
  });
});

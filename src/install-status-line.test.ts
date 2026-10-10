import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { tempHome } from "./testing/index.ts";

const installer = path.resolve(import.meta.dirname, "..", "scripts", "install-status-line.ts");
const statusLine = path.resolve(import.meta.dirname, "..", "scripts", "status-line.ts");

function install(file: string): void {
  execFileSync(process.execPath, [installer, file]);
}

describe("installing the status line", () => {
  it("sets statusLine with a refresh interval of a minute or more, keeping other settings", async () => {
    const file = path.join(await tempHome("install-status-line"), "settings.json");
    await writeFile(file, JSON.stringify({ hooks: { Stop: [] }, theme: "dark" }));

    install(file);

    const settings = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(settings.hooks, { Stop: [] });
    assert.equal(settings.theme, "dark");
    assert.equal(settings.statusLine.type, "command");
    assert.ok(settings.statusLine.command.includes(statusLine));
    assert.ok(settings.statusLine.refreshInterval >= 60);
  });

  it("creates the settings file when there is none", async () => {
    const file = path.join(await tempHome("install-status-line"), "claude", "settings.json");

    install(file);

    assert.equal(JSON.parse(await readFile(file, "utf8")).statusLine.type, "command");
  });

  it("is safe to re-run", async () => {
    const file = path.join(await tempHome("install-status-line"), "settings.json");

    install(file);
    const first = await readFile(file, "utf8");
    install(file);

    assert.equal(await readFile(file, "utf8"), first);
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const lib = resolve(import.meta.dirname, "../scripts/mods.sh");

function sh(script: string): string {
  return execFileSync("bash", ["-c", `source "${lib}"; ${script}`], { encoding: "utf8" });
}

function modsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "mods-"));
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(root, name, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, name, ".claude-plugin", "plugin.json"), "{}");
  }
  mkdirSync(join(root, "no-manifest"));
  return root;
}

describe("mods.sh", () => {
  it("lists each folder holding a plugin manifest and skips the rest", () => {
    const root = modsDir();
    assert.equal(sh(`_mods_with_manifest "${root}"`), `${root}/alpha\n${root}/beta\n`);
  });

  it("reports a registered mod and registers it only once", () => {
    const root = modsDir();
    const settings = join(root, "settings.json");
    const alpha = `${root}/alpha`;
    assert.throws(() => sh(`_mod_registered "${settings}" "${alpha}"`));
    sh(`_register_mod_dir "${settings}" "${alpha}"; _register_mod_dir "${settings}" "${alpha}"`);
    sh(`_mod_registered "${settings}" "${alpha}"`);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.CLAUDE_CODE_PLUGIN_DIRS, alpha);
  });
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

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

  it("offers each mod and registers the ones answered yes, reading answers from stdin", () => {
    const root = modsDir();
    const settings = join(root, "home", "settings.json");
    const out = execFileSync(
      "bash",
      [
        "-c",
        `source "${lib}"
        GREEN=; RESET=; SKIPPED=()
        note() { echo "$1"; }
        confirm() { local reply=""; echo "ask: $1"; read -r reply || true; [[ "$reply" =~ ^[Yy] ]]; }
        _register_mods "${root}" "${settings}"
        printf 'skipped: %s\\n' "\${SKIPPED[@]}"`,
      ],
      { encoding: "utf8", input: "y\nn\n" },
    );
    assert.match(out, /ask: Register mods\/alpha/);
    assert.match(out, /ask: Register mods\/beta/);
    assert.match(out, /skipped: session mod beta/);
    assert.doesNotMatch(out, /skipped: session mod alpha/);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.CLAUDE_CODE_PLUGIN_DIRS, `${root}/alpha`);
  });
});

describe("test-mods.sh", () => {
  const script = resolve(import.meta.dirname, "../scripts/test-mods.sh");

  function modsWithFakeClaude(...tests: Array<[name: string, source: string]>): string {
    const root = mkdtempSync(join(tmpdir(), "test-mods-"));
    roots.push(root);
    for (const [name, source] of tests) {
      mkdirSync(join(root, name, ".claude-plugin"), { recursive: true });
      writeFileSync(join(root, name, ".claude-plugin", "plugin.json"), "{}");
      mkdirSync(join(root, name, "hooks"));
      writeFileSync(join(root, name, "hooks", "a.test.ts"), source);
    }
    const fake = join(root, "fake-claude");
    writeFileSync(
      fake,
      `#!/usr/bin/env bash\necho "$1 $2 $3" >> "${join(root, "calls")}"\n[[ "$3" != */bad ]]\n`,
      { mode: 0o755 },
    );
    return root;
  }

  function run(root: string): { status: number | null; stderr: string; calls: string } {
    const out = spawnSync("bash", [script, root], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE: join(root, "fake-claude") },
    });
    const calls = join(root, "calls");
    return { status: out.status, stderr: out.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  }

  const hook = "import { test } from 'claude-code/testing'";
  const plain = "import { it } from 'node:test'";
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("tests each mod written with claude-code/testing, skips the rest, and fails when one fails", () => {
    const root = modsWithFakeClaude(["good", hook], ["bad", hook], ["plain", plain]);
    mkdirSync(join(root, "no-tests"));
    const { status, stderr, calls } = run(root);
    assert.equal(status, 1);
    assert.equal(calls, `plugin test ${root}/bad\nplugin test ${root}/good\n`);
    assert.match(stderr, /Hook tests failed: bad/);
  });

  it("passes when every mod's tests pass", () => {
    assert.equal(run(modsWithFakeClaude(["good", hook], ["fine", hook])).status, 0);
  });

  it("fails when the mods directory is missing or no mod was tested", () => {
    assert.equal(run(join(modsWithFakeClaude(), "missing")).status, 1);
    assert.equal(run(modsWithFakeClaude(["plain", plain])).status, 1);
  });
});

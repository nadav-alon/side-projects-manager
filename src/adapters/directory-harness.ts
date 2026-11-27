import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  Checkout,
  Harness,
  Scaffold,
  StandardsPreset,
  UniformComparison,
} from "../ports/index.ts";
import { CI_FILE, STANDARDS_FILE, UNIFORM_FILES, UnknownPreset } from "../ports/index.ts";
import { MANAGER_HOME } from "./manager-home.ts";

/** Where the generated, project-specific instructions go. */
const INSTRUCTIONS_FILE = "AGENTS.md";

/** The manager's presets, one markdown file per name. Never copied as a directory. */
const PRESETS_DIRECTORY = "docs/project-standards-presets";

/** What a project with no preset starts with. */
const STANDARDS_STUB = `# Project standards

This project has no rules beyond the uniform ones in \`docs/agents/coding-standards.md\`.
`;

/** Where the project's own workflows live; any file here means the project has CI of its own. */
const WORKFLOWS_DIRECTORY = ".github/workflows";

/**
 * What a project with no CI starts with: its own typecheck and test scripts,
 * on every pull request, so a pull request is never left waiting on checks
 * that no workflow will ever report. The npm steps run only where there is a
 * `package.json`, and a script the project does not define is skipped rather
 * than failed, so a pull request with nothing to check still goes green.
 */
const CI_WORKFLOW = `name: CI

on:
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    name: Typecheck and test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - if: hashFiles('package.json') != ''
        uses: actions/setup-node@v4
        with:
          node-version: 22.x

      - if: hashFiles('package.json') != ''
        run: if [ -f package-lock.json ]; then npm ci; else npm install; fi

      - if: hashFiles('package.json') != ''
        run: npm run typecheck --if-present

      - if: hashFiles('package.json') != ''
        run: npm test --if-present
`;

/**
 * The harness as files copied out of `source`, which is the manager's own
 * checkout unless a test says otherwise.
 *
 * Uniform files are overwritten, because a project whose copy has drifted is a
 * project reading conventions nobody maintains. The instructions file, the
 * standards file and the CI workflow are not: once a project has said something
 * about itself, that is the project's, and re-scaffolding must not talk over
 * it. The CI workflow is also written only to a checkout with no workflows of
 * its own, so a repo that already has CI under another name is not given a second.
 */
export function directoryHarness(source: string = MANAGER_HOME): Harness {
  return {
    async deploysToPages(directory: Checkout): Promise<boolean> {
      const workflows = path.join(directory, WORKFLOWS_DIRECTORY);
      for (const name of await presetFiles(workflows)) {
        if (!/\.ya?ml$/i.test(name)) {
          continue;
        }
        const text = await readFile(path.join(workflows, name), "utf8");
        if (/uses:\s*actions\/deploy-pages\b/.test(text)) {
          return true;
        }
      }
      return false;
    },

    async install(
      directory: Checkout,
      instructions: string,
      standards: string,
    ): Promise<Scaffold> {
      const paths: string[] = [];
      const overwritten: string[] = [];

      // Asked before the uniform files land, because some of them are workflows.
      const hadWorkflows = (await presetFiles(path.join(directory, WORKFLOWS_DIRECTORY))).length > 0;

      const writeOnce = async (file: string, contents: string): Promise<void> => {
        const to = path.join(directory, file);
        if (await exists(to)) {
          return;
        }
        await mkdir(path.dirname(to), { recursive: true });
        await writeFile(to, contents, "utf8");
        paths.push(file);
      };

      for (const file of UNIFORM_FILES) {
        const to = path.join(directory, file);
        // Asked before the copy, because afterwards every one of them exists.
        if (await exists(to)) {
          overwritten.push(file);
        }
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(path.join(source, file), to);
        paths.push(file);
      }

      await writeOnce(INSTRUCTIONS_FILE, instructions);
      await writeOnce(STANDARDS_FILE, standards);
      if (!hadWorkflows) {
        await writeOnce(CI_FILE, CI_WORKFLOW);
      }

      return { paths, overwritten };
    },

    async standards(preset?: StandardsPreset): Promise<string> {
      if (preset === undefined) {
        return STANDARDS_STUB;
      }
      const presets = path.join(source, PRESETS_DIRECTORY);
      const names = (await presetFiles(presets))
        .filter((file) => file.endsWith(".md"))
        .map((file) => file.slice(0, -".md".length))
        .sort();
      if (!names.includes(preset)) {
        throw new UnknownPreset(preset, names);
      }
      return readFile(path.join(presets, `${preset}.md`), "utf8");
    },

    async sync(directory: Checkout): Promise<string[]> {
      const changed: string[] = [];

      for (const file of UNIFORM_FILES) {
        const to = path.join(directory, file);
        const from = path.join(source, file);
        // Asked before the copy, so a file already in step is left with its
        // own mtime, rather than the copy this would otherwise become.
        if (await sameContent(to, from)) {
          continue;
        }
        changed.push(file);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
      }

      return changed;
    },

    async compareUniform(file: string, content: string): Promise<UniformComparison> {
      if (!(UNIFORM_FILES as readonly string[]).includes(file)) {
        return "different";
      }
      const bytes = Buffer.from(content, "utf8");
      const [current, ...earlier] = await mastersVersions(source, file);
      if (current !== undefined && bytes.equals(current)) {
        return "current";
      }
      for (const version of earlier) {
        if (bytes.equals(version)) {
          return "earlier";
        }
      }
      return "different";
    },
  };
}

/** The files in the presets directory; none when the manager has no such directory yet. */
async function presetFiles(presets: string): Promise<string[]> {
  try {
    return await readdir(presets);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Whether `to` exists and holds exactly what `from` does. A missing `to` never matches. */
async function sameContent(to: string, from: string): Promise<boolean> {
  let existing: Buffer;
  try {
    existing = await readFile(to);
  } catch {
    return false;
  }
  return existing.equals(await readFile(from));
}

const run = promisify(execFile);

/** The branch of `source` whose uniform files are the manager's own. */
const MASTER = "master";

/**
 * Every version of `file` on `source`'s `master`, newest first — what has
 * reached master, not what `source`'s working tree or checked-out branch
 * holds, since a sync that merges by itself must not trust bytes that never
 * landed. A `source` that is not a git checkout at all keeps no history:
 * its working-tree copy is then the only version. A `source` that is one but
 * has no `master`, or none holding `file`, has none.
 */
async function mastersVersions(source: string, file: string): Promise<Buffer[]> {
  try {
    await run("git", ["-C", source, "rev-parse", "--git-dir"]);
  } catch {
    return [await readFile(path.join(source, file))];
  }
  let commits: string[];
  try {
    const { stdout } = await run("git", ["-C", source, "log", "--format=%H", MASTER, "--", file]);
    commits = stdout.split("\n").filter((commit) => commit !== "");
  } catch {
    return [];
  }
  const versions: Buffer[] = [];
  for (const commit of commits) {
    try {
      const { stdout } = await run("git", ["-C", source, "show", `${commit}:${file}`], {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      });
      versions.push(stdout);
    } catch {
      // The commit that deleted the file has no version of it to show.
    }
  }
  return versions;
}

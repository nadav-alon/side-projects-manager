import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Checkout, Harness, Scaffold, UniformComparison } from "../ports/index.ts";
import { UNIFORM_FILES } from "../ports/index.ts";
import { MANAGER_HOME } from "./manager-home.ts";

/** Where the generated, project-specific instructions go. */
const INSTRUCTIONS_FILE = "AGENTS.md";

/**
 * The harness as files copied out of `source`, which is the manager's own
 * checkout unless a test says otherwise.
 *
 * Uniform files are overwritten, because a project whose copy has drifted is a
 * project reading conventions nobody maintains. The instructions file is not:
 * once a project has said something about itself, that is the project's, and
 * re-scaffolding must not talk over it.
 */
export function directoryHarness(source: string = MANAGER_HOME): Harness {
  return {
    async install(directory: Checkout, instructions: string): Promise<Scaffold> {
      const paths: string[] = [];
      const overwritten: string[] = [];

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

      const instructionsFile = path.join(directory, INSTRUCTIONS_FILE);
      if (!(await exists(instructionsFile))) {
        await writeFile(instructionsFile, instructions, "utf8");
        paths.push(INSTRUCTIONS_FILE);
      }

      return { paths, overwritten };
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
      if (bytes.equals(await readFile(path.join(source, file)))) {
        return "current";
      }
      for (const version of await earlierVersions(source, file)) {
        if (bytes.equals(version)) {
          return "earlier";
        }
      }
      return "different";
    },
  };
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

/**
 * Every version of `file` the `source` checkout's history holds, newest
 * first — none when `source` keeps no history, as a copy without `.git`
 * does not.
 */
async function earlierVersions(source: string, file: string): Promise<Buffer[]> {
  let commits: string[];
  try {
    const { stdout } = await run("git", ["-C", source, "log", "--format=%H", "--", file]);
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

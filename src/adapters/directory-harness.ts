import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Checkout, Harness, Scaffold } from "../ports/index.ts";
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

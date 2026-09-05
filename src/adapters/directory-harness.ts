import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Harness } from "../ports/index.ts";
import { MANAGER_HOME } from "./manager-home.ts";

/**
 * The files every project gets, byte for byte, at the paths the agent
 * instructions point at.
 *
 * These are the manager's own copies: the manager is a registered project like
 * any other, so improving the conventions it works under improves the ones
 * every project it scaffolds works under, from one source rather than four
 * drifting ones. Nothing listed here may name the manager, or a project would
 * arrive carrying a reference back to it.
 */
export const UNIFORM_FILES = [
  "docs/agents/coding-standards.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/triage-labels.md",
  "docs/agents/domain.md",
] as const;

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
    async install(directory: string, instructions: string): Promise<string[]> {
      const written: string[] = [];

      for (const file of UNIFORM_FILES) {
        const to = path.join(directory, file);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(path.join(source, file), to);
        written.push(file);
      }

      const instructionsFile = path.join(directory, INSTRUCTIONS_FILE);
      if (!(await exists(instructionsFile))) {
        await writeFile(instructionsFile, instructions, "utf8");
        written.push(INSTRUCTIONS_FILE);
      }

      return written;
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

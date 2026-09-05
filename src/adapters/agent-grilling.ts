import { spawn } from "node:child_process";

import type { Grilling } from "../ports/index.ts";

/**
 * What the session is asked to do. Written at the project, not at the
 * manager: the agent reads the instructions that were just scaffolded into the
 * checkout it is standing in, and writes the tickets into that project's own
 * tracker.
 */
const PROMPT =
  "Read AGENTS.md and docs/agents/ in this repo, then grill me on what this" +
  " project is for and what its first month should build. Turn what we agree" +
  " on into the project's first tickets in its issue tracker.";

/** The agent CLI, overridable for a developer who invokes it differently. */
const AGENT = process.env["SIDE_PROJECTS_AGENT"] || "claude";

/**
 * The grilling as an interactive agent session in the project checkout.
 *
 * Standard input, output and error are the developer's terminal, not this
 * process's to read: the whole point of the step is that a person is on the
 * other end of it. The command waits for the session and treats the
 * developer walking out of it as a finished grilling rather than a failure —
 * the project is registered by then either way.
 */
export const agentGrilling: Grilling = {
  async start(directory: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const session = spawn(AGENT, [PROMPT], {
        cwd: directory,
        stdio: "inherit",
      });

      session.on("error", reject);
      session.on("close", () => {
        resolve();
      });
    });
  },
};

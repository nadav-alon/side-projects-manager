import { spawn } from "node:child_process";

import type { Grilling, GrillingSubject } from "../ports/index.ts";

/**
 * How the session opens, whatever the project.
 *
 * The grilling is asked for by name: `/grill-with-docs` is a grilling and a
 * modelling session together, which is what makes the terms the conversation
 * settles on land in the project's own glossary rather than in a transcript
 * nobody opens again. It is the same pairing `docs/agents/domain.md` already
 * points every scaffolded project at. What it does is spelled out as well as
 * named, so a developer without that skill installed still gets the session
 * this describes.
 */
const OPENING =
  "/grill-with-docs Read AGENTS.md and docs/agents/ in this repo first.";

/**
 * The extra first move for a repo that predates the manager.
 *
 * Such a codebase already has language in it, and a grilling that ignored it
 * would agree a second vocabulary beside the one the code speaks. Bringing the
 * code into line is a ticket rather than something to do mid-conversation:
 * renaming is work the project should decide on, not a side effect of talking
 * about it.
 */
const EXISTING_LANGUAGE =
  " This codebase came before those conventions, so read it for the language" +
  " it already uses — the nouns in its modules, types and tickets — and bring" +
  " that vocabulary into the conversation rather than agreeing a parallel one" +
  " beside it. Where the code disagrees with the glossary we settle on, raise" +
  " a ticket for bringing the code into line rather than renaming anything" +
  " during the session.";

/** What the session is for, and what it must leave behind. */
const GRILLING =
  " Then grill me on what this project is for and what its first month should" +
  " build, writing the terms we settle on into CONTEXT.md as we agree them." +
  " Turn what we agree on into tickets in this project's issue tracker.";

/**
 * What the session is asked to do. Written at the project, not at the
 * manager: the agent reads the instructions that were just scaffolded into the
 * checkout it is standing in, and writes the tickets into that project's own
 * tracker.
 */
export function grillingPrompt(subject: GrillingSubject): string {
  return OPENING + (subject.existing ? EXISTING_LANGUAGE : "") + GRILLING;
}

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
  async start(subject: GrillingSubject): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const session = spawn(AGENT, [grillingPrompt(subject)], {
        cwd: subject.directory,
        stdio: "inherit",
      });

      session.on("error", reject);
      session.on("close", () => {
        resolve();
      });
    });
  },
};

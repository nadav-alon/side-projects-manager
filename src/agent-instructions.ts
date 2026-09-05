import { repoName } from "./ports/index.ts";
import type { RepoSlug } from "./ports/index.ts";

/** What the developer said the project is, when they asked for it. */
export interface ProjectDescription {
  repo: RepoSlug;
  /** One line, in the developer's words. May be empty. */
  description: string;
}

/**
 * The agent instructions a new project gets, generated for that project.
 *
 * Generated rather than copied, and deliberately so: a project that inherited
 * another repo's instructions would tell an agent about a codebase it is not
 * in. What is uniform lives in the files this points at; what is here is the
 * project's own name and purpose.
 *
 * Nothing produced here may name the scaffolding side. A project repo carries
 * no reference back to it, so that the developer can walk away with just the
 * project.
 */
export function agentInstructions(project: ProjectDescription): string {
  const name = repoName(project.repo);
  const description = project.description.trim();

  // Newline-terminated: the file is committed, and read in diffs.
  return `${[
    `# ${name}`,
    ...(description === "" ? [] : [description]),
    "Instructions for agents working in this repo. The files below are the" +
      " conventions this repo is written to; read the one that covers what" +
      " you are about to do.",
    "## Coding standards",
    "Branded primitives over bare ones, and comments that outlive the review" +
      " (`TODO[#n]`, never ticket narration). See" +
      " `docs/agents/coding-standards.md`.",
    "## Issue tracker",
    "Where this repo's issues live and how to drive them. See" +
      " `docs/agents/issue-tracker.md`.",
    "## Triage labels",
    "The five canonical triage roles, used verbatim as label strings. See" +
      " `docs/agents/triage-labels.md`.",
    "## Domain docs",
    "Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See" +
      " `docs/agents/domain.md`.",
  ].join("\n\n")}\n`;
}

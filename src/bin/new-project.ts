#!/usr/bin/env node
import { parseArgs } from "node:util";

import { agentGrilling } from "../adapters/agent-grilling.ts";
import { directoryHarness } from "../adapters/directory-harness.ts";
import { documentStore } from "../adapters/document-store.ts";
import { githubRepoHost } from "../adapters/github-repo-host.ts";
import { newProject, type NewProjectRequest } from "../new-project.ts";
import { repoSlug } from "../ports/index.ts";

const USAGE = `Usage: new-project <owner/repo> [description] [--existing]

  Creates the repo, clones it to the managed location, scaffolds the harness
  into it, registers it, and hands you an interactive session that turns the
  idea into the project's first tickets.

  --existing  Register a repo that is already on GitHub, rather than creating
              one. For projects that predate the manager.`;

/** The composition root of the new-project command, and nothing else. */
async function main(): Promise<void> {
  const request = readRequest(process.argv.slice(2));

  const report = await newProject(
    {
      host: githubRepoHost(),
      harness: directoryHarness(),
      grilling: agentGrilling,
      store: documentStore(),
    },
    request,
  );

  console.log(report.message);
}

/**
 * The developer's words as a request. A slug that isn't one, or a missing
 * one, is answered with the usage rather than a parse error: getting the
 * arguments wrong is the most likely way to reach this command, and the
 * command is meant to be the easy way to start something.
 */
function readRequest(argv: string[]): NewProjectRequest {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { existing: { type: "boolean", default: false } },
    allowPositionals: true,
  });

  const [repo, description = ""] = positionals;
  if (repo === undefined) {
    throw new Error(`a repo to start is required.\n\n${USAGE}`);
  }
  if (positionals.length > 2) {
    throw new Error(
      `unexpected argument ${JSON.stringify(positionals[2])}; quote the description.\n\n${USAGE}`,
    );
  }

  return { repo: repoSlug(repo), description, existing: values.existing };
}

main().catch((error: unknown) => {
  // A command that could not start a project says why; it never greets the
  // developer with a stack trace.
  console.error(
    `new-project failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

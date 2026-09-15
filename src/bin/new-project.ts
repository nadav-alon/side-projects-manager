#!/usr/bin/env node
import { parseArgs } from "node:util";

import { agentGrilling } from "../adapters/agent-grilling.ts";
import { directoryHarness } from "../adapters/directory-harness.ts";
import { documentStore } from "../adapters/document-store.ts";
import { githubRepoHost } from "../adapters/github-repo-host.ts";
import { errorMessage } from "../error-message.ts";
import { newProject, type NewProjectRequest } from "../new-project.ts";
import { repoSlug } from "../ports/index.ts";

const USAGE = `Usage: new-project <owner/repo> [description] [--existing]

  Creates the repo, clones it to the managed location, scaffolds the harness
  into it, registers it, and hands you an interactive session that turns the
  idea into the project's first tickets.

  --existing  Register a repo that is already on GitHub, rather than creating
              one. For projects that predate the manager. Its harness is
              proposed as a draft pull request rather than committed to a
              branch you had, and the project is registered paused until you
              merge it.`;

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
 * The developer's words as a request.
 *
 * Anything wrong with them — a missing repo, a name that isn't `owner/repo`,
 * a flag that doesn't exist, a description left unquoted — is answered with
 * the usage. Getting the arguments wrong is the most likely way to reach this
 * command, and the command is meant to be the easy way to start something.
 */
function readRequest(argv: string[]): NewProjectRequest {
  try {
    return parseRequest(argv);
  } catch (error) {
    throw new Error(`${errorMessage(error)}\n\n${USAGE}`);
  }
}

function parseRequest(argv: string[]): NewProjectRequest {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { existing: { type: "boolean", default: false } },
    allowPositionals: true,
  });

  const [repo, description = ""] = positionals;
  if (repo === undefined) {
    throw new Error("a repo to start is required.");
  }
  if (positionals.length > 2) {
    throw new Error(
      `unexpected argument ${JSON.stringify(positionals[2])}; quote the description.`,
    );
  }

  return { repo: repoSlug(repo), description, existing: values.existing };
}

main().catch((error: unknown) => {
  // A command that could not start a project says why; it never greets the
  // developer with a stack trace.
  console.error(`new-project failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});

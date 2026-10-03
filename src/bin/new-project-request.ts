import { parseArgs } from "node:util";

import type { NewProjectRequest } from "../new-project.ts";
import { repoSlug, standardsPreset } from "../ports/index.ts";

/**
 * The developer's words, as `argv` past the command name, turned into a
 * {@link NewProjectRequest}. Throws a plain error naming what was wrong;
 * `readRequest` in `new-project.ts` is what appends the usage text to it.
 *
 * Separated from `new-project.ts` so a test can exercise argument parsing
 * directly, without importing a module whose `main()` runs unconditionally
 * at the top level.
 */
export function parseRequest(argv: string[]): NewProjectRequest {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      existing: { type: "boolean", default: false },
      public: { type: "boolean", default: false },
      standards: { type: "string" },
    },
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
  if (values.public && values.existing) {
    throw new Error(
      "--public creates a repo; with --existing the repo already exists — change its visibility on GitHub.",
    );
  }

  return {
    repo: repoSlug(repo),
    description,
    existing: values.existing,
    public: values.public,
    ...(values.standards !== undefined && { standards: standardsPreset(values.standards) }),
  };
}

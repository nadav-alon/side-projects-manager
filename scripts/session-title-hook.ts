// A `UserPromptSubmit` hook: when the prompt invokes a mode skill, titles the
// session `<mode>: <owner/repo>` and the terminal tab to match. Reads the
// hook's JSON on stdin; answers on stdout, or says nothing for any other prompt.
// `scripts/setup-wizard.sh` installs it into the developer's settings.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { isRemoteUrl, repoOfRemote } from "../src/ports/remote-url.ts";
import type { RepoSlug } from "../src/ports/repo-slug.ts";
import {
  isOwnTitle,
  modeOf,
  terminalTitleSequence,
  ticketOf,
  titleOf,
} from "../src/session-title.ts";

/** `owner/repo` of the cwd's origin remote, if it has one. */
function repoOf(cwd: string): RepoSlug | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return isRemoteUrl(url) ? repoOfRemote(url) : undefined;
  } catch {
    // No git, no checkout, or no origin.
    return undefined;
  }
}

function main(): void {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (typeof input !== "object" || input === null) {
    return;
  }
  const { prompt, cwd, session_title } = input as {
    prompt?: unknown;
    cwd?: unknown;
    session_title?: unknown;
  };
  if (typeof prompt !== "string") {
    return;
  }
  const mode = modeOf(prompt);
  if (mode === undefined) {
    return;
  }
  if (
    typeof session_title === "string" &&
    session_title !== "" &&
    !isOwnTitle(session_title)
  ) {
    return;
  }
  const directory = typeof cwd === "string" ? cwd : process.cwd();
  const repo = repoOf(directory);
  const title = titleOf(mode, repo, directory, ticketOf(prompt, repo));
  process.stdout.write(
    JSON.stringify({
      terminalSequence: terminalTitleSequence(title),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        sessionTitle: title,
      },
    }),
  );
}

main();

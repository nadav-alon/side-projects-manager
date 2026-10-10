// A `UserPromptSubmit` hook: when the prompt invokes a mode skill, titles the
// session `<mode>: <owner/repo>` and the terminal tab to match. Reads the
// hook's JSON on stdin; answers on stdout, or says nothing for any other prompt.
// `scripts/setup-wizard.sh` installs it into the developer's settings.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isRepoSlug } from "../src/ports/repo-slug.ts";

/** The skills that open an interactive session worth telling apart. */
const MODES = "grilling|grill-me|standup|triage|wayfinder";
const MODE_PROMPT = new RegExp(`^\\/(?:[\\w-]+:)?(${MODES})(?=\\s|$)`);

/** A title this hook set: how it tells its own from one the developer chose. */
const OWN_TITLE = new RegExp(`^(?:${MODES}): `);

/** The ticket a mode skill's arguments name, as `#n` or an issue URL. */
function ticketOf(prompt: string): string | undefined {
  return /(?:#|\/issues\/)(\d+)\b/.exec(prompt)?.[1];
}

/** The mode named by a prompt that starts with a mode skill. */
function modeOf(prompt: string): string | undefined {
  return MODE_PROMPT.exec(prompt.trimStart())?.[1];
}

/** `owner/repo` of the cwd's origin remote, else the cwd's directory name. */
function repoOf(cwd: string): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const slug = /([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(url)?.[1];
    if (slug !== undefined && isRepoSlug(slug)) {
      return slug;
    }
  } catch {
    // No git, no checkout, or no origin: fall through to the directory name.
  }
  return path.basename(cwd);
}

function main(): void {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
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
    !OWN_TITLE.test(session_title)
  ) {
    return;
  }
  const ticket = ticketOf(prompt);
  const repo = repoOf(typeof cwd === "string" ? cwd : process.cwd());
  const title = `${mode}: ${repo}${ticket === undefined ? "" : `#${ticket}`}`;
  process.stdout.write(
    JSON.stringify({
      terminalSequence: `\u001b]2;${title}\u0007`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        sessionTitle: title,
      },
    }),
  );
}

main();

// A `UserPromptSubmit` hook: when the prompt invokes a mode skill, titles the
// session `<mode>: <owner/repo>` and the terminal tab to match. Reads the
// hook's JSON on stdin; answers on stdout, or says nothing for any other prompt.
// `scripts/setup-wizard.sh` installs it into the developer's settings.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isRepoSlug } from "../src/ports/repo-slug.ts";

/** The skills that open an interactive session worth telling apart. */
const MODE_PROMPT = /^\/(?:[\w-]+:)?(grilling|grill-me|standup|triage|wayfinder)(?=\s|$)/;

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
  const { prompt, cwd } = input as { prompt?: unknown; cwd?: unknown };
  if (typeof prompt !== "string") {
    return;
  }
  const mode = modeOf(prompt);
  if (mode === undefined) {
    return;
  }
  const title = `${mode}: ${repoOf(typeof cwd === "string" ? cwd : process.cwd())}`;
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

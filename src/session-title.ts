import path from "node:path";

import { isIssueNumber } from "./ports/issue-number.ts";
import type { IssueNumber } from "./ports/issue-number.ts";
import { sameRepo } from "./ports/repo-slug.ts";
import type { RepoSlug } from "./ports/repo-slug.ts";

/** The skills that open an interactive session worth telling apart. */
export const MODES = [
  "grilling",
  "grill-me",
  "standup",
  "triage",
  "wayfinder",
] as const;

export type Mode = (typeof MODES)[number];

const MODE_ALTERNATION = MODES.join("|");
const MODE_PROMPT = new RegExp(`^\\/(?:[\\w-]+:)?(${MODE_ALTERNATION})(?=\\s|$)`);

/**
 * Whole-shape match for a title this hook set, `<mode>: <repo>[#n]`: how it
 * tells its own from one the developer chose, even one sharing the prefix.
 */
const OWN_TITLE = new RegExp(`^(?:${MODE_ALTERNATION}): [^\\s#]+(?:#\\d+)?$`);

/** A ticket reference: bare `#n`, `owner/repo#n`, or that ticket's issue URL. */
const TICKET_REFERENCE =
  /^(?:#|([\w.-]+\/[\w.-]+)#|https?:\/\/[^/\s]+\/([\w.-]+\/[\w.-]+)\/issues\/)(\d+)(?!\w)/;

/** The mode named by a prompt that starts with a mode skill. */
export function modeOf(prompt: string): Mode | undefined {
  return MODE_PROMPT.exec(prompt.trimStart())?.[1] as Mode | undefined;
}

/**
 * The ticket of `repo` a mode skill's arguments name. A reference to another
 * repo's ticket is passed over, as is any reference when `repo` is unknown
 * but for a bare `#n`.
 */
export function ticketOf(
  prompt: string,
  repo: RepoSlug | undefined,
): IssueNumber | undefined {
  for (const word of prompt.split(/\s+/)) {
    const match = TICKET_REFERENCE.exec(word);
    if (match === null) {
      continue;
    }
    const named = match[1] ?? match[2];
    const number = Number(match[3]);
    if (
      isIssueNumber(number) &&
      (named === undefined || (repo !== undefined && sameRepo(named, repo)))
    ) {
      return number;
    }
  }
  return undefined;
}

/** Whether `title` is one `titleOf` produced, rather than one chosen by hand. */
export function isOwnTitle(title: string): boolean {
  return OWN_TITLE.test(title);
}

/**
 * `<mode>: <repo>[#n]`. Without a slug, the checkout's directory name stands
 * in, stripped of control characters so it cannot end or inject into the
 * terminal sequence the title is written in.
 */
export function titleOf(
  mode: Mode,
  repo: RepoSlug | undefined,
  cwd: string,
  ticket: IssueNumber | undefined,
): string {
  const name =
    repo ?? path.basename(cwd).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return `${mode}: ${name}${ticket === undefined ? "" : `#${ticket}`}`;
}

/** The terminal's OSC 2 sequence, which sets the tab's title. */
export function terminalTitleSequence(title: string): string {
  return `\u001b]2;${title}\u0007`;
}

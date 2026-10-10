// The CLI's `statusLine` command: reads the status line's JSON on stdin and
// prints one line — the session's mode as a coloured badge, the repo and
// branch, the model, the session's spend, then the loop's state.
//
// The loop's state is read off the manager home's files (`halt`,
// `journal.json`), never by running the loop's commands: the line re-runs on
// an interval, and a missing home or an unparseable journal leaves that part
// blank rather than breaking the line.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const HOME = process.env["SIDE_PROJECTS_MANAGER_HOME"] || path.resolve(import.meta.dirname, "..");

const RESET = "\u001b[0m";
/** A session titled `<mode>: …` shows its mode in this colour; any other title shows no badge. */
const MODE_COLOURS: Record<string, string> = {
  grill: "\u001b[35m",
  standup: "\u001b[36m",
  triage: "\u001b[33m",
  wayfinder: "\u001b[32m",
};

interface StatusInput {
  session_name?: unknown;
  cwd?: unknown;
  model?: { display_name?: unknown };
  cost?: { total_cost_usd?: unknown };
}

function badge(sessionName: unknown): string {
  if (typeof sessionName !== "string") return "";
  const mode = /^([a-z]+):/.exec(sessionName)?.[1];
  const colour = mode === undefined ? undefined : MODE_COLOURS[mode];
  return mode === undefined || colour === undefined ? "" : `${colour}${mode}${RESET}`;
}

function repoAndBranch(cwd: unknown): string {
  if (typeof cwd !== "string") return "";
  const git = (...args: string[]): string => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  const top = git("rev-parse", "--show-toplevel");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const repo = path.basename(top || cwd);
  return branch === "" ? repo : `${repo}@${branch}`;
}

/** `halted`, `in flight: owner/repo#n (m min)`, or empty when idle or unreadable. */
function loopState(home: string, now: number): string {
  try {
    readFileSync(path.join(home, "halt"));
    return "halted";
  } catch {
    // Not halted, or no home to read.
  }
  try {
    const journal: unknown = JSON.parse(readFileSync(path.join(home, "journal.json"), "utf8"));
    const records = (journal as { records?: unknown }).records;
    if (!Array.isArray(records)) return "";
    const open = records.filter((r) => r && typeof r === "object" && r.closedAt === undefined).at(-1);
    if (open === undefined) return "";
    const run = Array.isArray(open.runs) ? open.runs.at(-1) : undefined;
    const startedAt = Date.parse(run?.startedAt ?? open.openedAt);
    if (Number.isNaN(startedAt)) return "";
    const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
    const ticket = run ? `${run.repo}#${run.number}` : undefined;
    return ticket === undefined ? `in flight (${minutes} min)` : `in flight: ${ticket} (${minutes} min)`;
  } catch {
    return "";
  }
}

function main(): void {
  let input: StatusInput = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as StatusInput;
  } catch {
    // An unreadable stdin still gets the loop's part.
  }
  const cost = input.cost?.total_cost_usd;
  const model = input.model?.display_name;
  const parts = [
    badge(input.session_name),
    repoAndBranch(input.cwd),
    typeof model === "string" ? model : "",
    typeof cost === "number" ? `$${cost.toFixed(2)}` : "",
    loopState(HOME, Date.now()),
  ].filter((part) => part !== "");
  console.log(parts.join(" "));
}

main();

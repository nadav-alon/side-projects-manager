// The CLI's `statusLine` command: reads the status line's JSON on stdin and
// prints one line — the session's mode as a coloured badge, the repo and
// branch, the model, the session's spend, then the loop's state.
//
// The loop's state is read off the manager home's files (`halt`,
// `journal.json`), never by running the loop's commands: the line re-runs on
// an interval, and a missing home or an unparseable journal leaves that part
// blank rather than breaking the line.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { documentStore } from "../src/adapters/document-store.ts";
import { fileHalt } from "../src/adapters/file-halt.ts";
import { MANAGER_HOME } from "../src/adapters/manager-home.ts";
import { isProcessAlive } from "../src/adapters/process-alive.ts";
import { isClosedInvocation } from "../src/ports/journal.ts";

/** The loop's part is recomputed at most this often, however often the line re-runs. */
const LOOP_STATE_TTL_MS = 60_000;

const RESET = "\u001b[0m";
/**
 * A session titled `<mode>: …` shows its mode in this colour; any other title shows no badge. The
 * keys are the modes the session-naming hook titles a session with.
 */
const MODE_COLOURS = {
  grilling: "\u001b[35m",
  "grill-me": "\u001b[35m",
  standup: "\u001b[36m",
  triage: "\u001b[33m",
  wayfinder: "\u001b[32m",
} as const;

function isMode(word: string): word is keyof typeof MODE_COLOURS {
  return Object.hasOwn(MODE_COLOURS, word);
}

interface StatusInput {
  session_name?: unknown;
  cwd?: unknown;
  model?: { display_name?: unknown };
  cost?: { total_cost_usd?: unknown };
}

function badge(sessionName: unknown): string {
  if (typeof sessionName !== "string") return "";
  const mode = /^([a-z-]+):/.exec(sessionName)?.[1];
  return mode !== undefined && isMode(mode) ? `${MODE_COLOURS[mode]}${mode}${RESET}` : "";
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

/** `halted`, `in flight: owner/repo#n (m min)`, or empty when idle, between runs, dead or unreadable. */
async function computeLoopState(home: string, now: number): Promise<string> {
  try {
    if (await fileHalt(home).engaged()) return "halted";
    const journal = await documentStore(home).loadJournal();
    const open = journal.records.filter((record) => !isClosedInvocation(record)).at(-1);
    // A record whose process died never closes; it is not in flight.
    if (open === undefined || !isProcessAlive(open.process)) return "";
    const run = open.runs?.at(-1);
    if (run === undefined) return "";
    const minutes = Math.max(0, Math.floor((now - run.startedAt.getTime()) / 60_000));
    return `in flight: ${run.repo}#${run.number} (${minutes} min)`;
  } catch {
    return "";
  }
}

/** The loop's part, read from a stamp file under the temp dir when it is under a minute old. */
async function loopState(home: string, now: number): Promise<string> {
  const stamp = path.join(
    os.tmpdir(),
    `side-projects-status-line-${createHash("sha256").update(home).digest("hex").slice(0, 16)}.json`,
  );
  try {
    const cached = JSON.parse(readFileSync(stamp, "utf8")) as { at?: unknown; state?: unknown };
    if (typeof cached.at === "number" && typeof cached.state === "string" && now - cached.at < LOOP_STATE_TTL_MS) {
      return cached.state;
    }
  } catch {
    // No stamp, or an unreadable one: recompute.
  }
  const state = await computeLoopState(home, now);
  try {
    writeFileSync(stamp, JSON.stringify({ at: now, state }));
  } catch {
    // An unwritable temp dir only costs the cache.
  }
  return state;
}

async function main(): Promise<void> {
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
    await loopState(MANAGER_HOME, Date.now()),
  ].filter((part) => part !== "");
  console.log(parts.join(" "));
}

await main();

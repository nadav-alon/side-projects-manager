import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Budget,
  ProjectState,
  RegisteredProject,
  RepoSlug,
  RunCost,
  State,
  Store,
} from "../ports/index.ts";
import {
  DEFAULT_BUDGET,
  isPriority,
  isRepoSlug,
  isReserveFraction,
  isTokenCount,
  isUsd,
} from "../ports/index.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const REGISTRY_FILE = "registry.json";
const BUDGET_FILE = "budget.json";
const STATE_FILE = "state.json";

/**
 * The registry, budget and state documents as JSON files under `home`.
 *
 * All three are optional on disk. A machine with no registry has nothing
 * registered, a machine with no budget runs under the default one, and a
 * machine with no state has worked nothing yet; none is an error, so the loop
 * runs on a clean checkout. A document that exists but cannot be read as what
 * it claims to be is an error, because silently ignoring a typo in the
 * registry would silently stop working a project — and silently ignoring one
 * in the budget would spend the reserve the developer thought they had set.
 *
 * The budget is its own document rather than a section of the registry
 * because the new-project command rewrites the registry, and a budget living
 * there would be rewritten out of existence by a command that has no business
 * touching it.
 */
export function documentStore(home: string = MANAGER_HOME): Store {
  const registryFile = path.join(home, REGISTRY_FILE);
  const budgetFile = path.join(home, BUDGET_FILE);
  const stateFile = path.join(home, STATE_FILE);

  return {
    async loadRegistry(): Promise<RegisteredProject[]> {
      return parseRegistry(await readDocument(registryFile), registryFile);
    },

    async saveRegistry(projects: RegisteredProject[]): Promise<void> {
      await writeDocument(home, registryFile, formatRegistry(projects));
    },

    async loadBudget(): Promise<Budget> {
      return parseBudget(await readDocument(budgetFile), budgetFile);
    },

    async loadState(): Promise<State> {
      return parseState(await readDocument(stateFile), stateFile);
    },

    async saveState(state: State): Promise<void> {
      await writeDocument(home, stateFile, formatState(state));
    },
  };
}

async function writeDocument(
  home: string,
  file: string,
  contents: string,
): Promise<void> {
  await mkdir(home, { recursive: true });
  // Written beside the document and renamed over it, so a write interrupted
  // part way leaves the previous document intact rather than half a file.
  const pending = `${file}.pending`;
  await writeFile(pending, contents, "utf8");
  await rename(pending, file);
}

/** The document's parsed contents, or undefined if it is absent or empty. */
async function readDocument(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(error)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `{ "projects": [{ "repo": "owner/repo", "paused": true, "priority": 1 }] }`
 *
 * `paused` and `priority` are optional: a project is registered active and
 * without an explicit priority unless the developer says otherwise.
 */
function parseRegistry(
  document: unknown,
  file: string,
): RegisteredProject[] {
  if (document === undefined) {
    return [];
  }
  const projects = fieldOf(document, "projects", file);
  if (projects === undefined) {
    return [];
  }
  if (!Array.isArray(projects)) {
    throw new Error(`${file}: "projects" must be a list of projects.`);
  }

  const registered = new Set<string>();
  return projects.map((entry, index) => {
    const where = `${file}: project ${index + 1}`;
    const repo = fieldOf(entry, "repo", where);
    if (typeof repo !== "string" || !isRepoSlug(repo)) {
      throw new Error(
        `${where}: "repo" must be a repo slug, as owner/repo: ${JSON.stringify(repo)}`,
      );
    }
    // State is keyed by slug, so a project listed twice would be considered
    // twice and share one last-worked entry with itself.
    if (registered.has(repo)) {
      throw new Error(`${where}: ${repo} is already registered.`);
    }
    registered.add(repo);

    const paused = fieldOf(entry, "paused", where) ?? false;
    if (typeof paused !== "boolean") {
      throw new Error(`${where}: "paused" must be true or false.`);
    }

    const priority = fieldOf(entry, "priority", where);
    if (priority === undefined) {
      return { repo, paused };
    }
    if (typeof priority !== "number" || !isPriority(priority)) {
      throw new Error(
        `${where}: "priority" must be a whole number of 1 or more: ${JSON.stringify(priority)}`,
      );
    }
    return { repo, paused, priority };
  });
}

/**
 * `{ "fiveHourAllowance": 50000000, "weeklyAllowance": 500000000,
 *    "reserveFraction": 0.5, "spendCeiling": 5 }`
 *
 * Every field is optional and falls back to `DEFAULT_BUDGET`, so a developer
 * who only wants to move the reserve writes one line. A field that is present
 * but not a usable value is an error rather than a fallback: a reserve the
 * developer believes they set and the loop silently ignored is the one
 * failure this whole gate exists to prevent.
 */
function parseBudget(document: unknown, file: string): Budget {
  if (document === undefined) {
    return DEFAULT_BUDGET;
  }

  return {
    fiveHourAllowance: numberOr(
      DEFAULT_BUDGET.fiveHourAllowance,
      fieldOf(document, "fiveHourAllowance", file),
      isTokenCount,
      `${file}: "fiveHourAllowance" must be a whole number of tokens, 0 or more`,
    ),
    weeklyAllowance: numberOr(
      DEFAULT_BUDGET.weeklyAllowance,
      fieldOf(document, "weeklyAllowance", file),
      isTokenCount,
      `${file}: "weeklyAllowance" must be a whole number of tokens, 0 or more`,
    ),
    reserveFraction: numberOr(
      DEFAULT_BUDGET.reserveFraction,
      fieldOf(document, "reserveFraction", file),
      isReserveFraction,
      `${file}: "reserveFraction" must be at least 0 and less than 1`,
    ),
    spendCeiling: numberOr(
      DEFAULT_BUDGET.spendCeiling,
      fieldOf(document, "spendCeiling", file),
      isUsd,
      `${file}: "spendCeiling" must be a dollar amount above 0`,
    ),
  };
}

/** `value` narrowed by `is`, `fallback` when absent, an error when neither. */
function numberOr<T extends number>(
  fallback: T,
  value: unknown,
  is: (candidate: number) => candidate is T,
  complaint: string,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !is(value)) {
    throw new Error(`${complaint}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `{ "projects": { "owner/repo": { "lastWorkedAt": "…", "runs": [ … ] } } }`
 *
 * Keyed by repo slug, so a project renamed in the registry loses its history
 * rather than inheriting another project's.
 */
function parseState(document: unknown, file: string): State {
  const state = new Map<RepoSlug, ProjectState>();
  if (document === undefined) {
    return state;
  }
  const projects = fieldOf(document, "projects", file);
  if (projects === undefined) {
    return state;
  }
  if (!isRecord(projects)) {
    throw new Error(`${file}: "projects" must map a repo slug to its state.`);
  }

  for (const [repo, entry] of Object.entries(projects)) {
    const where = `${file}: ${repo}`;
    if (!isRepoSlug(repo)) {
      throw new Error(`${where}: not a repo slug, expected owner/repo.`);
    }

    const lastWorkedAt = fieldOf(entry, "lastWorkedAt", where);
    const runs = fieldOf(entry, "runs", where) ?? [];
    if (!Array.isArray(runs)) {
      throw new Error(`${where}: "runs" must be a list of runs.`);
    }

    state.set(repo, {
      ...(lastWorkedAt !== undefined && {
        lastWorkedAt: parseInstant(lastWorkedAt, `${where}: "lastWorkedAt"`),
      }),
      runs: runs.map((run, index) => parseRun(run, `${where}: run ${index + 1}`)),
    });
  }

  return state;
}

function parseRun(run: unknown, where: string): RunCost {
  const tokensUsed = fieldOf(run, "tokensUsed", where);
  if (typeof tokensUsed !== "number" || !isTokenCount(tokensUsed)) {
    throw new Error(
      `${where}: "tokensUsed" must be a whole number of 0 or more: ${JSON.stringify(tokensUsed)}`,
    );
  }
  return {
    at: parseInstant(fieldOf(run, "at", where), `${where}: "at"`),
    tokensUsed,
  };
}

function parseInstant(value: unknown, where: string): Date {
  const at = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) {
    throw new Error(
      `${where} must be an ISO 8601 timestamp: ${JSON.stringify(value)}`,
    );
  }
  return at;
}

function fieldOf(value: unknown, field: string, where: string): unknown {
  if (!isRecord(value)) {
    throw new Error(`${where}: expected an object.`);
  }
  return value[field];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The registry as the developer would have written it by hand: defaults left
 * out, so a project they never paused and never prioritised stays the one
 * field it started as.
 */
function formatRegistry(projects: RegisteredProject[]): string {
  const entries = projects.map((project) => ({
    repo: project.repo,
    ...(project.paused && { paused: true }),
    ...(project.priority !== undefined && { priority: project.priority }),
  }));

  return `${JSON.stringify({ projects: entries }, undefined, 2)}\n`;
}

/** Indented and newline-terminated: the document is read in diffs. */
function formatState(state: State): string {
  const projects = Object.fromEntries(
    [...state].map(([repo, project]) => [
      repo,
      {
        ...(project.lastWorkedAt !== undefined && {
          lastWorkedAt: project.lastWorkedAt.toISOString(),
        }),
        runs: project.runs.map((run) => ({
          at: run.at.toISOString(),
          tokensUsed: run.tokensUsed,
        })),
      },
    ]),
  );

  return `${JSON.stringify({ projects }, undefined, 2)}\n`;
}

import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  Budget,
  Day,
  ExitCode,
  InvocationClosing,
  InvocationOutcome,
  InvocationRecord,
  IssueUrl,
  Journal,
  JournaledProject,
  JournaledSummaryFailure,
  KeptSummaryPath,
  ModelDefaults,
  ModelName,
  OpenInvocation,
  ProcessId,
  ProjectState,
  TokenCount,
  RegisteredProject,
  RepoSlug,
  RunCost,
  Salvage,
  Size,
  SpendCeiling,
  State,
  Store,
  TicketKind,
  WorkedTicket,
  WorkedToday,
} from "../ports/index.ts";
import {
  DEFAULT_BUDGET,
  INVOCATION_OUTCOMES,
  JOURNAL_LIMIT,
  KEPT_SUMMARY_LIMIT,
  MODEL_NAME_SHAPE,
  SIZES,
  TICKET_KINDS,
  exitCode,
  findInvocationRecord,
  isBranch,
  isDay,
  isExitCode,
  isInvocationOutcome,
  isIssueNumber,
  isIssueUrl,
  isIterationLimit,
  isKeptSummaryPath,
  isModelName,
  isPriority,
  isProcessId,
  isRepoSlug,
  isSize,
  keptSummaryPath,
  workedTicket,
  isReserveFraction,
  isTokenCount,
  isUsd,
  spendCeilingFor,
} from "../ports/index.ts";
import { MANAGER_HOME } from "./manager-home.ts";
import { errorMessage } from "../error-message.ts";
import { summaryFileName } from "../summary.ts";

const REGISTRY_FILE = "registry.json";
const BUDGET_FILE = "budget.json";
const STATE_FILE = "state.json";
const MODELS_FILE = "models.json";
const JOURNAL_FILE = "journal.json";

/**
 * The registry, budget, model defaults, state and journal documents as JSON
 * files under `home`.
 *
 * All five are optional on disk. A machine with no registry has nothing
 * registered, a machine with no budget runs under the default one, a machine
 * with no model defaults runs every kind on the image's model, a machine
 * with no state has worked nothing yet, and a machine with no journal has
 * never had an invocation recorded; none is an error, so the loop
 * runs on a clean checkout. A document that exists but cannot be read as what
 * it claims to be is an error, because silently ignoring a typo in the
 * registry would silently stop working a project — and silently ignoring one
 * in the budget would spend the reserve the developer thought they had set.
 *
 * The budget is its own document rather than a section of the registry
 * because the new-project command rewrites the registry, and a budget living
 * there would be rewritten out of existence by a command that has no business
 * touching it. The journal is its own document rather than a section of the
 * state for the same reason state is its own document rather than a section
 * of the registry: a different author (here, none — both are machine-written,
 * but at a different rate) and a different shape, append-only and keyed by
 * time rather than rewritten wholesale and keyed by project.
 */
export function documentStore(home: string = MANAGER_HOME): Store {
  const registryFile = path.join(home, REGISTRY_FILE);
  const budgetFile = path.join(home, BUDGET_FILE);
  const stateFile = path.join(home, STATE_FILE);
  const modelsFile = path.join(home, MODELS_FILE);
  const journalFile = path.join(home, JOURNAL_FILE);

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

    async loadModelDefaults(): Promise<ModelDefaults> {
      return parseModelDefaults(await readDocument(modelsFile), modelsFile);
    },

    async loadState(): Promise<State> {
      return parseState(await readDocument(stateFile), stateFile);
    },

    async saveState(state: State): Promise<void> {
      await writeDocument(home, stateFile, formatState(state));
    },

    async openInvocation(opened: OpenInvocation): Promise<OpenInvocation> {
      const journal = await loadJournalDocument(journalFile);
      journal.records.push({ openedAt: opened.openedAt, process: opened.process });
      await writeJournal(home, journalFile, journal);
      return { ...opened };
    },

    async closeInvocation(
      opened: OpenInvocation,
      closing: InvocationClosing,
    ): Promise<void> {
      const journal = await loadJournalDocument(journalFile);
      const record = findInvocationRecord(journal.records, opened);
      if (record === undefined) {
        throw new Error(
          `${journalFile}: no invocation record opened at ${opened.openedAt.toISOString()} by process ${opened.process}.`,
        );
      }
      if (record.closedAt !== undefined) {
        throw new Error(
          `${journalFile}: the invocation record opened at ${opened.openedAt.toISOString()} by process ${opened.process} is already closed.`,
        );
      }
      Object.assign(record, closing);
      await writeJournal(home, journalFile, journal);
    },

    async loadJournal(): Promise<Journal> {
      return loadJournalDocument(journalFile);
    },

    async keepSummary(startedAt: Date, body: string): Promise<KeptSummaryPath> {
      const file = path.join(home, summaryFileName(startedAt));
      // A fixed pending name, unlike `writeDocument`'s: the target name is
      // timestamped rather than one of a handful of fixed document names, so
      // deriving the pending name from it would make every kept summary's
      // pending file a different, unpredictable path.
      const pending = path.join(home, "summary.txt.pending");
      await mkdir(home, { recursive: true });
      await writeFile(pending, body, "utf8");
      await rename(pending, file);
      await trimKeptSummaries(home);
      return keptSummaryPath(file);
    },
  };
}

/** Keeps at most `KEPT_SUMMARY_LIMIT` kept summaries in `home`, oldest deleted first. */
async function trimKeptSummaries(home: string): Promise<void> {
  const kept = (await readdir(home))
    .filter((entry) => /^summary-.*\.txt$/.test(entry))
    .sort();
  const excess = kept.slice(0, Math.max(0, kept.length - KEPT_SUMMARY_LIMIT));
  await Promise.all(excess.map((entry) => unlink(path.join(home, entry))));
}

async function loadJournalDocument(journalFile: string): Promise<Journal> {
  return parseJournal(await readDocument(journalFile), journalFile);
}

/** Trims to `JOURNAL_LIMIT`, oldest first, before writing — every write, not only when it overflows. */
async function writeJournal(
  home: string,
  journalFile: string,
  journal: Journal,
): Promise<void> {
  const trimmed: Journal = {
    records: journal.records.slice(-JOURNAL_LIMIT),
  };
  await writeDocument(home, journalFile, formatJournal(trimmed));
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
    const repo = repoSlugField(entry, where);
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
 *    "reserveFraction": 0.5, "fiveHourReserveFraction": 0, "spendCeiling": 10,
 *    "sizes": { "S": 500000 }, "unsizedCountsAs": "M" }`
 *
 * Every field is optional and falls back to `DEFAULT_BUDGET` — bar
 * `observedResetAt`, which has no default because a boundary nobody has seen
 * is one the ledger must go on inferring. A developer who only wants to move
 * the reserve writes one line. A field that is present
 * but not a usable value is an error rather than a fallback, and so is a field
 * that is not one of these: a reserve the developer believes they set and
 * the loop silently ignored is the one failure this whole gate exists to
 * prevent, and `"reserve"` for `"reserveFraction"` fails exactly that way.
 */
function parseBudget(document: unknown, file: string): Budget {
  if (document === undefined) {
    return DEFAULT_BUDGET;
  }
  rejectUnknownFields(document, BUDGET_FIELDS, "setting", file);

  return {
    fiveHourAllowance: numberField(
      fieldOf(document, "fiveHourAllowance", file),
      isAllowance,
      `${file}: "fiveHourAllowance" must be a whole number of tokens above 0`,
      DEFAULT_BUDGET.fiveHourAllowance,
    ),
    weeklyAllowance: numberField(
      fieldOf(document, "weeklyAllowance", file),
      isAllowance,
      `${file}: "weeklyAllowance" must be a whole number of tokens above 0`,
      DEFAULT_BUDGET.weeklyAllowance,
    ),
    reserveFraction: numberField(
      fieldOf(document, "reserveFraction", file),
      isReserveFraction,
      `${file}: "reserveFraction" must be at least 0 and less than 1`,
      DEFAULT_BUDGET.reserveFraction,
    ),
    fiveHourReserveFraction: numberField(
      fieldOf(document, "fiveHourReserveFraction", file),
      isReserveFraction,
      `${file}: "fiveHourReserveFraction" must be at least 0 and less than 1`,
      DEFAULT_BUDGET.fiveHourReserveFraction,
    ),
    spendCeiling: spendCeilingField(
      fieldOf(document, "spendCeiling", file),
      file,
    ),
    maxConcurrentIterations: numberField(
      fieldOf(document, "maxConcurrentIterations", file),
      isIterationLimit,
      `${file}: "maxConcurrentIterations" must be a whole number of 1 or more`,
      DEFAULT_BUDGET.maxConcurrentIterations,
    ),
    sizes: sizesField(fieldOf(document, "sizes", file), file),
    unsizedCountsAs: stringField(
      fieldOf(document, "unsizedCountsAs", file),
      isSize,
      `${file}: "unsizedCountsAs" must be one of ${SIZES.join(", ")}`,
      DEFAULT_BUDGET.unsizedCountsAs,
    ),
    ...observedResetField(fieldOf(document, "observedResetAt", file), file),
  };
}

/**
 * `10` or `{ "S": 3, "M": 5, "L": 10, "XL": 20 }`
 *
 * A number is one ceiling for every size. An object is per size, and every
 * size is optional and falls back to the flat default
 * `DEFAULT_BUDGET.spendCeiling` names for it, so a document raising just `L`
 * leaves the other three at that flat figure.
 */
function spendCeilingField(value: unknown, file: string): SpendCeiling {
  if (value === undefined) {
    return DEFAULT_BUDGET.spendCeiling;
  }
  if (typeof value === "number") {
    if (!isUsd(value)) {
      throw new Error(
        `${file}: "spendCeiling" must be a dollar amount above 0, or an object keyed by size (${SIZES.join(", ")}): ${JSON.stringify(value)}`,
      );
    }
    return value;
  }
  return perSizeField(
    value,
    file,
    "spendCeiling",
    isUsd,
    (size) => `${file}: "spendCeiling.${size}" must be a dollar amount above 0`,
    (size) => spendCeilingFor(size, DEFAULT_BUDGET.spendCeiling),
  );
}

/**
 * `{ "S": 500000, "M": 2000000 }`
 *
 * Every size is optional and falls back to the default for that size alone,
 * so a document raising just `L` leaves the other three where they were.
 */
function sizesField(value: unknown, file: string): Record<Size, TokenCount> {
  if (value === undefined) {
    return DEFAULT_BUDGET.sizes;
  }
  return perSizeField(
    value,
    file,
    "sizes",
    isTokenCount,
    (size) => `${file}: "sizes.${size}" must be a whole number of tokens, 0 or more`,
    (size) => DEFAULT_BUDGET.sizes[size],
  );
}

/**
 * A field keyed by size, each key optional and independently validated by
 * `is`, falling back to `fallback(size)` when that key is absent.
 * `spendCeilingField` and `sizesField` are the same shape once the guard, the
 * per-size message and the per-size fallback are parameters.
 */
function perSizeField<T extends number>(
  value: unknown,
  file: string,
  fieldName: string,
  is: (candidate: number) => candidate is T,
  message: (size: Size) => string,
  fallback: (size: Size) => T,
): Record<Size, T> {
  rejectUnknownFields(value, SIZES, "size", `${file}: "${fieldName}"`);
  return Object.fromEntries(
    SIZES.map((size) => [
      size,
      numberField(
        fieldOf(value, size, `${file}: "${fieldName}"`),
        is,
        message(size),
        fallback(size),
      ),
    ]),
  ) as Record<Size, T>;
}

/**
 * The observed reset, as an ISO 8601 instant — `"2026-09-12T08:00:00Z"`.
 *
 * Spread rather than assigned, so a budget that names no reset has no such
 * property at all instead of one holding `undefined`.
 *
 * A timestamp without a zone is refused rather than read as local time. The
 * developer copies this off a display showing their own clock and the loop
 * compares it against instants from the session logs, which are UTC; a naive
 * string would be believed to the hour and wrong by the offset, and a wrong
 * boundary is worse than the inference it replaced.
 */
function observedResetField(
  value: unknown,
  file: string,
): { observedResetAt?: Date } {
  if (value === undefined) {
    return {};
  }
  const message = `${file}: "observedResetAt" must be an ISO 8601 instant with a zone, such as "2026-09-12T08:00:00Z"`;
  if (typeof value !== "string" || !HAS_ZONE.test(value)) {
    throw new Error(message);
  }
  const observedResetAt = new Date(value);
  if (Number.isNaN(observedResetAt.getTime())) {
    throw new Error(message);
  }
  return { observedResetAt };
}

/**
 * A trailing `Z` or a `+hh:mm` / `-hh:mm` offset. Lower-case `z` counts:
 * RFC 3339 allows it and `Date` parses it, and a developer who wrote a zone
 * should not be told they wrote none.
 */
const HAS_ZONE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * A window's declared size. A token count, and never 0: an allowance of
 * nothing leaves nothing spendable, and the gate lets a window through while
 * it has consumed no more than it may, so 0 would authorise a run every
 * morning rather than stopping them. A developer who wants the mornings to
 * stop pauses the projects or raises the reserve.
 */
function isAllowance(value: number): value is TokenCount {
  return isTokenCount(value) && value > 0;
}

const BUDGET_FIELDS = [
  "fiveHourAllowance",
  "weeklyAllowance",
  "reserveFraction",
  "fiveHourReserveFraction",
  "spendCeiling",
  "maxConcurrentIterations",
  "sizes",
  "unsizedCountsAs",
  "observedResetAt",
] as const;

/**
 * Complains about anything in `document` that is not one of `known`, calling
 * each key a `noun` — what the document's keys are to the developer who wrote
 * them.
 *
 * For a document whose every key is optional, an unrecognised key is
 * indistinguishable from a misspelled one, and a misspelling reads as a
 * setting the developer never made. Refusing the document is the only way that
 * mistake surfaces before a morning has run on it.
 */
function rejectUnknownFields(
  document: unknown,
  known: readonly string[],
  noun: string,
  file: string,
): void {
  if (!isRecord(document)) {
    throw new Error(`${file}: expected an object.`);
  }
  const unknown = Object.keys(document).filter(
    (field) => !known.includes(field),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${file}: no such ${noun}: ${unknown.join(", ")}. Expected any of: ${known.join(", ")}.`,
    );
  }
}

/** `value` narrowed by `is`, `fallback` when absent, an error when neither. */
function numberField<T extends number>(
  value: unknown,
  is: (candidate: number) => candidate is T,
  message: string,
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !is(value)) {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** `value` narrowed by `is`, `fallback` when absent, an error when neither. */
function stringField<T extends string>(
  value: unknown,
  is: (candidate: string) => candidate is T,
  message: string,
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !is(value)) {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `{ "implementation": "sonnet", "review": "opus" }`
 *
 * Every kind is optional, and a kind left out has no default. A name is taken
 * as written, never checked against a list of models. What is refused is a
 * key that is not a kind, for the budget's reason: a misspelt kind reads
 * exactly like one left out, and would silently run on the image's model.
 */
function parseModelDefaults(document: unknown, file: string): ModelDefaults {
  if (document === undefined) {
    return {};
  }
  rejectUnknownFields(document, TICKET_KINDS, "kind", file);

  const defaults: Partial<Record<TicketKind, ModelName>> = {};
  for (const kind of TICKET_KINDS) {
    const name = fieldOf(document, kind, file);
    if (name === undefined) {
      continue;
    }
    if (typeof name !== "string" || !isModelName(name)) {
      throw new Error(
        `${file}: "${kind}" must be ${MODEL_NAME_SHAPE}: ${JSON.stringify(name)}`,
      );
    }
    defaults[kind] = name;
  }
  return defaults;
}

/**
 * `{ "projects": { "owner/repo": { "lastWorkedAt": "…", "runs": [ … ] } } }`
 *
 * Keyed by repo slug, so a project renamed in the registry loses its history
 * rather than inheriting another project's.
 */
function parseState(document: unknown, file: string): State {
  if (document === undefined) {
    return { projects: new Map() };
  }
  const workedToday = fieldOf(document, "workedToday", file);
  const announcedOn = fieldOf(document, "announcedOn", file);
  const salvages = fieldOf(document, "salvages", file);
  return {
    projects: parseProjectStates(fieldOf(document, "projects", file), file),
    ...(workedToday !== undefined && {
      workedToday: parseWorkedToday(workedToday, `${file}: "workedToday"`),
    }),
    ...(announcedOn !== undefined && {
      announcedOn: parseDayField(announcedOn, `${file}: "announcedOn"`),
    }),
    ...(salvages !== undefined && {
      salvages: parseSalvages(salvages, `${file}: "salvages"`),
    }),
  };
}

/**
 * `[{ "repo": "owner/repo", "number": 7, "branch": "issue-7-salvage",
 *    "limitRefusals": 1 }]`
 */
function parseSalvages(value: unknown, where: string): Salvage[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be a list of salvages.`);
  }
  return value.map((salvage, index) =>
    parseSalvage(salvage, `${where}: salvage ${index + 1}`),
  );
}

function parseSalvage(salvage: unknown, where: string): Salvage {
  const { repo, number } = parseWorkedTicket(salvage, where);
  const branch = fieldOf(salvage, "branch", where);
  if (typeof branch !== "string" || !isBranch(branch)) {
    throw new Error(`${where}: "branch" must be a git branch name: ${JSON.stringify(branch)}`);
  }
  const limitRefusals = fieldOf(salvage, "limitRefusals", where);
  if (
    typeof limitRefusals !== "number" ||
    !Number.isInteger(limitRefusals) ||
    limitRefusals < 0
  ) {
    throw new Error(
      `${where}: "limitRefusals" must be a whole number of 0 or more: ${JSON.stringify(limitRefusals)}`,
    );
  }
  return { repo, number, branch, limitRefusals };
}

function parseDayField(value: unknown, where: string): Day {
  if (typeof value !== "string" || !isDay(value)) {
    throw new Error(
      `${where} must be a calendar day, as YYYY-MM-DD: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * `{ "day": "2026-01-01", "tickets": [{ "repo": "owner/repo", "number": 7 }] }`
 *
 * Read as written, whatever day it names: whether that day is today is the
 * loop's to judge, since only the loop has a clock.
 */
function parseWorkedToday(value: unknown, where: string): WorkedToday {
  const recorded = parseDayField(fieldOf(value, "day", where), `${where}: "day"`);
  const tickets = fieldOf(value, "tickets", where);
  if (!Array.isArray(tickets)) {
    throw new Error(`${where}: "tickets" must be a list of tickets.`);
  }
  return {
    day: recorded,
    tickets: tickets.map((ticket, index) =>
      parseWorkedTicket(ticket, `${where}: ticket ${index + 1}`),
    ),
  };
}

function parseWorkedTicket(ticket: unknown, where: string): WorkedTicket {
  const repo = repoSlugField(ticket, where);
  const number = fieldOf(ticket, "number", where);
  if (typeof number !== "number" || !isIssueNumber(number)) {
    throw new Error(
      `${where}: "number" must be a whole number of 1 or more: ${JSON.stringify(number)}`,
    );
  }
  return { repo, number };
}

function parseProjectStates(
  projects: unknown,
  file: string,
): Map<RepoSlug, ProjectState> {
  const state = new Map<RepoSlug, ProjectState>();
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

/** The `"repo"` field of `value`, which must be a repo slug. */
function repoSlugField(value: unknown, where: string): RepoSlug {
  const repo = fieldOf(value, "repo", where);
  if (typeof repo !== "string" || !isRepoSlug(repo)) {
    throw new Error(
      `${where}: "repo" must be a repo slug, as owner/repo: ${JSON.stringify(repo)}`,
    );
  }
  return repo;
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
    [...state.projects].map(([repo, project]) => [
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

  const workedToday = state.workedToday && {
    day: state.workedToday.day,
    tickets: state.workedToday.tickets.map(workedTicket),
  };

  const salvages = state.salvages?.map((salvage) => ({ ...salvage }));

  return `${JSON.stringify(
    { projects, workedToday, announcedOn: state.announcedOn, salvages },
    undefined,
    2,
  )}\n`;
}

const RECORD_FIELDS = [
  "openedAt",
  "process",
  "closedAt",
  "outcome",
  "projects",
  "standDownReason",
  "summaryLocation",
  "summaryFailure",
  "exitCode",
] as const;

/**
 * `{ "records": [{ "openedAt": "…", "process": 123, "closedAt": "…",
 *    "outcome": "work-selected", "projects": [{ "repo": "owner/repo",
 *    "tokensUsed": 12000 }], "standDownReason": "…",
 *    "summaryLocation": "https://github.com/owner/repo/issues/1",
 *    "summaryFailure": { "reason": "…", "keptAt": "…" } }] }`
 *
 * A record with no `closedAt` is in flight, and carries nothing else — the
 * fields closing adds are read only once `closedAt` says they were written.
 */
function parseJournal(document: unknown, file: string): Journal {
  if (document === undefined) {
    return { records: [] };
  }
  const records = fieldOf(document, "records", file);
  if (records === undefined) {
    return { records: [] };
  }
  if (!Array.isArray(records)) {
    throw new Error(`${file}: "records" must be a list of invocation records.`);
  }
  return {
    records: records.map((record, index) =>
      parseInvocationRecord(record, `${file}: record ${index + 1}`),
    ),
  };
}

function parseInvocationRecord(
  record: unknown,
  where: string,
): InvocationRecord {
  rejectUnknownFields(record, RECORD_FIELDS, "field", where);

  const openedAt = parseInstant(
    fieldOf(record, "openedAt", where),
    `${where}: "openedAt"`,
  );
  const process = processField(fieldOf(record, "process", where), where);

  const closedAt = fieldOf(record, "closedAt", where);
  if (closedAt === undefined) {
    return { openedAt, process };
  }

  return {
    openedAt,
    process,
    closedAt: parseInstant(closedAt, `${where}: "closedAt"`),
    outcome: outcomeField(fieldOf(record, "outcome", where), where),
    projects: journaledProjectsField(fieldOf(record, "projects", where), where),
    ...standDownReasonField(fieldOf(record, "standDownReason", where), where),
    ...summaryLocationField(fieldOf(record, "summaryLocation", where), where),
    ...summaryFailureField(fieldOf(record, "summaryFailure", where), where),
    ...exitCodeField(fieldOf(record, "exitCode", where), where),
  };
}

function processField(value: unknown, where: string): ProcessId {
  if (typeof value !== "number" || !isProcessId(value)) {
    throw new Error(
      `${where}: "process" must be a whole number above 0: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function outcomeField(value: unknown, where: string): InvocationOutcome {
  if (typeof value !== "string" || !isInvocationOutcome(value)) {
    throw new Error(
      `${where}: "outcome" must be one of ${INVOCATION_OUTCOMES.join(", ")}: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function journaledProjectsField(
  value: unknown,
  where: string,
): JournaledProject[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where}: "projects" must be a list of projects.`);
  }
  return value.map((project, index) => {
    const projectWhere = `${where}: project ${index + 1}`;
    const repo = repoSlugField(project, projectWhere);
    const tokensUsed = fieldOf(project, "tokensUsed", projectWhere);
    if (typeof tokensUsed !== "number" || !isTokenCount(tokensUsed)) {
      throw new Error(
        `${projectWhere}: "tokensUsed" must be a whole number of tokens, 0 or more: ${JSON.stringify(tokensUsed)}`,
      );
    }
    return { repo, tokensUsed };
  });
}

function standDownReasonField(
  value: unknown,
  where: string,
): { standDownReason?: string } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error(`${where}: "standDownReason" must be a string: ${JSON.stringify(value)}`);
  }
  return { standDownReason: value };
}

function summaryLocationField(
  value: unknown,
  where: string,
): { summaryLocation?: IssueUrl } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string" || !isIssueUrl(value)) {
    throw new Error(
      `${where}: "summaryLocation" must be an issue URL: ${JSON.stringify(value)}`,
    );
  }
  return { summaryLocation: value };
}

function summaryFailureField(
  value: unknown,
  where: string,
): { summaryFailure?: JournaledSummaryFailure } {
  if (value === undefined) {
    return {};
  }
  const failureWhere = `${where}: "summaryFailure"`;
  const reason = fieldOf(value, "reason", failureWhere);
  if (typeof reason !== "string") {
    throw new Error(
      `${failureWhere}: "reason" must be a string: ${JSON.stringify(reason)}`,
    );
  }
  const keptAt = fieldOf(value, "keptAt", failureWhere);
  if (
    keptAt !== undefined &&
    (typeof keptAt !== "string" || !isKeptSummaryPath(keptAt))
  ) {
    throw new Error(
      `${failureWhere}: "keptAt" must be an absolute path: ${JSON.stringify(keptAt)}`,
    );
  }
  return {
    summaryFailure: { reason, ...(keptAt !== undefined && { keptAt }) },
  };
}

function exitCodeField(value: unknown, where: string): { exitCode?: ExitCode } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !isExitCode(value)) {
    throw new Error(
      `${where}: "exitCode" must be a whole number from 0 to 255: ${JSON.stringify(value)}`,
    );
  }
  return { exitCode: exitCode(value) };
}

/** Indented and newline-terminated: the document is read in diffs. */
function formatJournal(journal: Journal): string {
  const records = journal.records.map((record) => ({
    openedAt: record.openedAt.toISOString(),
    process: record.process,
    ...(record.closedAt !== undefined && {
      closedAt: record.closedAt.toISOString(),
      outcome: record.outcome,
      projects: (record.projects ?? []).map(({ repo, tokensUsed }) => ({
        repo,
        tokensUsed,
      })),
      ...(record.standDownReason !== undefined && {
        standDownReason: record.standDownReason,
      }),
      ...(record.summaryLocation !== undefined && {
        summaryLocation: record.summaryLocation,
      }),
      ...(record.summaryFailure !== undefined && {
        summaryFailure: {
          reason: record.summaryFailure.reason,
          ...(record.summaryFailure.keptAt !== undefined && {
            keptAt: record.summaryFailure.keptAt,
          }),
        },
      }),
      ...(record.exitCode !== undefined && { exitCode: record.exitCode }),
    }),
  }));

  return `${JSON.stringify({ records }, undefined, 2)}\n`;
}

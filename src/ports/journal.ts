import type { ProcessId } from "./process-id.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { TokenCount } from "./token-count.ts";

/**
 * What became of an invocation, once it is known.
 *
 * Deliberately its own copy of the four variants `morningLoop` reports,
 * rather than an import from it: the store port must not depend on the loop's
 * own module, and a string union costs nothing to duplicate.
 */
export const INVOCATION_OUTCOMES = [
  "dry-queue",
  "stood-down",
  "work-selected",
  "invocation-failed",
] as const;

export type InvocationOutcome = (typeof INVOCATION_OUTCOMES)[number];

/** Whether `value` is one of the four invocation outcomes. */
export function isInvocationOutcome(
  value: string,
): value is InvocationOutcome {
  return (INVOCATION_OUTCOMES as readonly string[]).includes(value);
}

/** One project an invocation worked, and what it cost across every run made against it. */
export interface JournaledProject {
  repo: RepoSlug;
  tokensUsed: TokenCount;
}

/**
 * What opening an invocation record captures, and everything closing it
 * later needs to find it again.
 */
export interface OpenInvocation {
  /** When the invocation started. */
  openedAt: Date;
  /** The process that opened it. */
  process: ProcessId;
}

/** What closing a record adds to it: what the invocation came to. */
export interface InvocationClosing {
  /** When the invocation ended. */
  closedAt: Date;
  outcome: InvocationOutcome;
  /** Every project the invocation worked. Empty for a quiet or broken morning. */
  projects: JournaledProject[];
  /** Why the invocation stood down, absent when it did not. */
  standDownReason?: string;
}

/**
 * One journal entry: opened before the loop runs, closed with its report. A
 * record with no `closedAt` is in flight — the invocation that opened it is
 * either still running or died before it could close.
 */
export interface InvocationRecord
  extends OpenInvocation,
    Partial<InvocationClosing> {}

/** The journal in force: every invocation record the store has kept, oldest first. */
export interface Journal {
  records: InvocationRecord[];
}

/** Whether `record` has been closed. */
export function isClosedInvocation(
  record: InvocationRecord,
): record is InvocationRecord & InvocationClosing {
  return record.closedAt !== undefined;
}

/**
 * The record in `records` opened at `opened`'s instant by `opened`'s
 * process, whatever its closed state. Same `openedAt` instant, same process
 * is what identifies a record — a domain rule every store implementation
 * shares, not an adapter detail either is free to redecide.
 */
export function findInvocationRecord(
  records: readonly InvocationRecord[],
  opened: OpenInvocation,
): InvocationRecord | undefined {
  return records.find(
    (record) =>
      record.openedAt.getTime() === opened.openedAt.getTime() &&
      record.process === opened.process,
  );
}

/**
 * How many records the journal keeps. Trimmed to this many, oldest dropped
 * first, every time it is written — a record is a few dozen bytes, so being
 * generous here costs nothing but keeps the document from growing forever.
 */
export const JOURNAL_LIMIT = 50;

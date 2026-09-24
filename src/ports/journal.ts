import type { ExitCode } from "./exit-code.ts";
import type { IssueNumber } from "./issue-number.ts";
import type { IssueUrl } from "./issue-url.ts";
import type { TicketKind } from "./issue-tracker.ts";
import type { KeptSummaryPath } from "./kept-summary-path.ts";
import type { ProcessId } from "./process-id.ts";
import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { TokenCount } from "./token-count.ts";
import type { TranscriptDirectory } from "./transcript-directory.ts";

/**
 * What became of an invocation, once it is known.
 *
 * The first four are their own copy of the variants `morningLoop` reports,
 * rather than an import from it: the store port must not depend on the loop's
 * own module, and a string union costs nothing to duplicate. `never-reported`
 * is the journal's own fifth: the loop's process left no record at all, so the
 * trigger that spawned it wrote one in its place — see `bin/morning-run.ts`.
 */
export const INVOCATION_OUTCOMES = [
  "dry-queue",
  "stood-down",
  "work-selected",
  "invocation-failed",
  "never-reported",
] as const;

export type InvocationOutcome = (typeof INVOCATION_OUTCOMES)[number];

/** Whether `value` is one of the five invocation outcomes. */
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

/**
 * Why a summary could not be published, and where its composed text was
 * kept so the one write that lost it did not also cost the developer the
 * account of it. `keptAt` is absent when that write itself failed too — the
 * reason the publish failed is still worth recording even then.
 */
export interface JournaledSummaryFailure {
  reason: string;
  keptAt?: KeptSummaryPath;
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
  /**
   * Where a published summary landed — the journal's index into the tracker.
   * Absent when no summary published this invocation, or its publish failed.
   */
  summaryLocation?: IssueUrl;
  /**
   * Why a summary could not be published, absent when one published, or
   * none was attempted this invocation.
   */
  summaryFailure?: JournaledSummaryFailure;
  /**
   * The exit code the loop's process gave the trigger that spawned it.
   * Expected only on a `never-reported` record — the one outcome a record
   * never carries for itself, since it is written by the trigger rather than
   * by the loop — though nothing here enforces that pairing.
   */
  exitCode?: ExitCode;
}

/**
 * One run the invocation has going right now — CONTEXT.md's "Run in
 * progress": what `status` needs to name it, from what the manager itself
 * recorded when it started the run, never from parsing a prompt or a
 * container command line. Cleared from the invocation record the moment the
 * run ends, whatever it came to.
 *
 * `pullRequest` is present only for a pull request ticket's run — copied
 * from the ticket's own `pullRequest` binding at the moment the manager
 * started the run, never parsed back out of a prompt or a container command
 * line. Absent for an implementation run, which is bound to no pull request.
 */
export interface RunInProgress {
  kind: TicketKind;
  repo: RepoSlug;
  number: IssueNumber;
  startedAt: Date;
  transcriptDirectory: TranscriptDirectory;
  pullRequest?: PullRequestUrl;
}

/**
 * One journal entry: opened before the loop runs, closed with its report. A
 * record with no `closedAt` is in flight — the invocation that opened it is
 * either still running or died before it could close.
 */
export interface InvocationRecord
  extends OpenInvocation,
    Partial<InvocationClosing> {
  /**
   * Every run this invocation has going right now. Absent reads the same as
   * empty — CONTEXT.md's "Run in progress".
   */
  runs?: RunInProgress[];
}

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
 * Whether `a` and `b` name the same invocation: same `openedAt` instant, same
 * process — a domain rule every store implementation shares, not an adapter
 * detail either is free to redecide.
 */
export function sameInvocation(a: OpenInvocation, b: OpenInvocation): boolean {
  return a.openedAt.getTime() === b.openedAt.getTime() && a.process === b.process;
}

/**
 * The record in `records` opened at `opened`'s instant by `opened`'s
 * process, whatever its closed state.
 */
export function findInvocationRecord(
  records: readonly InvocationRecord[],
  opened: OpenInvocation,
): InvocationRecord | undefined {
  return records.find((record) => sameInvocation(record, opened));
}

/**
 * How many records the journal keeps. Trimmed to this many, oldest dropped
 * first, every time it is written — a record is a few dozen bytes, so being
 * generous here costs nothing but keeps the document from growing forever.
 */
export const JOURNAL_LIMIT = 50;

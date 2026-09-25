/**
 * A developer's standing "do nothing" for every trigger: engaged by `halt`,
 * cleared by `resume`.
 *
 * Not one of the loop's seven ports (CONTEXT.md: Port) — `morningLoop` never
 * sees this, exactly like the invocation lease. It exists only for whatever
 * calls `morningLoop`, checked ahead of the lease: a halted firing must take
 * no lease and claim no day, so it has to turn back before either is ever
 * asked for. See ADR 0008.
 */
import path from "node:path";

import { HALT_FILE, fileHalt } from "./adapters/file-halt.ts";
import { MANAGER_HOME } from "./adapters/manager-home.ts";

/**
 * The command a developer runs to clear the halt, named once so every
 * message that tells them to run it — `status`, `halt`, and a halted
 * firing's own log line — stays in step if it's ever renamed.
 */
export const RESUME_COMMAND = "npm run resume";

export interface Halt {
  /** Whether the loop is currently halted. */
  engaged(): Promise<boolean>;

  /**
   * Engages the halt. Returns `true` when this call is the one that engaged
   * it, `false` when it was already engaged — idempotent either way.
   */
  engage(): Promise<boolean>;

  /**
   * Clears the halt. Returns `true` when this call is the one that cleared
   * it, `false` when it was already clear — idempotent either way.
   */
  clear(): Promise<boolean>;
}

/**
 * Engages the halt, and returns the line to print: what `halt` and `stop`
 * both do first, unconditionally, since a developer reaching for either
 * wants the loop to stay quiet afterwards, not just one invocation ended.
 * Idempotent — engaging an already-engaged halt says so rather than
 * pretending it just happened.
 *
 * Names the halt file's own path: `MANAGER_HOME` here can differ from a
 * firing's — an interactive shell and the cron line can disagree about
 * `SIDE_PROJECTS_MANAGER_HOME` — and a halt written where a firing never
 * looks would otherwise hold silently.
 */
export async function engageHalt(): Promise<string> {
  const haltFile = path.join(MANAGER_HOME, HALT_FILE);
  const engaged = await fileHalt().engage();
  return engaged
    ? `Halted: the loop will do nothing until you run \`${RESUME_COMMAND}\`. (${haltFile})`
    : `Already halted. (${haltFile})`;
}

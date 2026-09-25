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

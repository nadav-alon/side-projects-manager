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
export interface Halt {
  /** Whether the loop is currently halted. */
  engaged(): Promise<boolean>;

  /**
   * Engages the halt. Returns `true` when this call is the one that engaged
   * it, `false` when it was already engaged — idempotent either way.
   */
  engage(): Promise<boolean>;

  /**
   * Lifts the halt. Returns `true` when this call is the one that lifted it,
   * `false` when it was already lifted — idempotent either way.
   */
  lift(): Promise<boolean>;
}

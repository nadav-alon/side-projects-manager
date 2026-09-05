/**
 * The interactive session that turns an idea into a project's first tickets.
 *
 * A port rather than a spawn at the call site because everything either side
 * of it is unattended and testable, and this one step deliberately is not:
 * the developer is meant to be in this conversation.
 */
export interface Grilling {
  /** Hands the developer a session in the checkout at `directory`. */
  start(directory: string): Promise<void>;
}

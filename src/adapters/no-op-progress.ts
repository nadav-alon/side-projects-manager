import type { Progress } from "../ports/progress.ts";

/**
 * Reports nothing. The default progress adapter: whatever composes it has
 * nowhere to put a line — a test, or any other caller that never asked to
 * watch an invocation run.
 */
export const noOpProgress: Progress = {
  note: () => {},
};

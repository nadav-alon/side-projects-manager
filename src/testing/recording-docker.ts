import { recordingBinary, type RecordedCalls } from "./recording.ts";

/** The `docker` that was on PATH, and how it was called while it was. */
export type RecordedDocker = RecordedCalls;

/**
 * Puts a `docker` on PATH for the length of the test and records how it was
 * called; see `recordingBinary` for how and why.
 *
 * A test reaches `dockerCommand`, `readAgentRun`, `readExitedRun` and
 * `dockerNeverRan` the way any caller does: through `containerSandbox()`'s
 * own default container, with `docker` on PATH standing in for the real
 * thing.
 */
export function recordingDocker(
  t: { after: (fn: () => void) => void },
  body: string,
): Promise<RecordedDocker> {
  return recordingBinary(t, "docker", body);
}

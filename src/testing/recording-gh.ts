import { recordingBinary, type RecordedCalls } from "./recording.ts";

/** The `gh` that was on PATH, and how it was called while it was. */
export type RecordedGh = RecordedCalls;

/**
 * Puts a `gh` on PATH for the length of the test and records how it was
 * called; see `recordingBinary` for how and why.
 */
export function recordingGh(
  t: { after: (fn: () => void) => void },
  body: string,
): Promise<RecordedGh> {
  return recordingBinary(t, "gh", body);
}

/**
 * Stands in for `gh` for the length of one test: an empty backlog for
 * whatever repo is asked, and a summary issue "created" without leaving one
 * behind — so a suite that writes on every invocation isn't checked against
 * the real tracker.
 */
export async function emptyBacklogGh(t: {
  after: (fn: () => void) => void;
}): Promise<RecordedGh> {
  return recordingGh(
    t,
    [
      `case "$1 $2" in`,
      `  "issue list") echo "[]" ;;`,
      `  "issue create") echo "https://github.com/nadav-alon/side-projects-manager/issues/0" ;;`,
      `  *) : ;;`,
      `esac`,
    ].join("\n"),
  );
}

/** The first invocation carrying all of `arguments_`, if there was one. */
export function callWith(
  calls: string[][],
  ...arguments_: string[]
): string[] | undefined {
  return calls.find((call) =>
    arguments_.every((argument) => call.includes(argument)),
  );
}

/** The value `gh` was given for `flag`, so a test can name one at a time. */
export function valueOf(
  call: string[] | undefined,
  flag: string,
): string | undefined {
  const at = call?.indexOf(flag) ?? -1;
  return at === -1 ? undefined : call?.[at + 1];
}

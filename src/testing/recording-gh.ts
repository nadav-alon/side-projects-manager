import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** What marks the start of one recorded invocation in the record. */
const CALL_SEPARATOR = "--- call ---";

/** The `gh` that was on PATH, and how it was called while it was. */
export interface RecordedGh {
  /** Every invocation, as its argument list, in the order they happened. */
  calls(): Promise<string[][]>;
}

/**
 * Puts a `gh` on PATH for the length of the test and records how it was
 * called. `body` is the script's, minus the shebang, and decides what each
 * invocation answers with.
 *
 * The adapters that shell out to `gh` write as well as read — a pull request,
 * an issue — so what they owe the developer cannot be checked against the real
 * tracker without leaving something behind on every run. It is checked against
 * the arguments instead, which is where the promise is kept or broken.
 *
 * Arguments are recorded NUL-separated rather than one per line, because the
 * argument worth asserting about is often `--body`, and a body is several
 * lines. Split on newlines, every assertion about one would silently be an
 * assertion about its first line.
 */
export async function recordingGh(
  t: { after: (fn: () => void) => void },
  body: string,
): Promise<RecordedGh> {
  const path_ = process.env["PATH"];

  const bin = await mkdtemp(path.join(tmpdir(), "gh-recording-"));
  const calls = path.join(bin, "calls");
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\0' '${CALL_SEPARATOR}' "$@" >> "${calls}"\n${body}\n`,
    { mode: 0o755 },
  );
  process.env["PATH"] = `${bin}:${path_ ?? ""}`;

  t.after(() => {
    process.env["PATH"] = path_;
  });

  return {
    async calls(): Promise<string[][]> {
      const recorded = await readFile(calls, "utf8").catch(() => "");
      const fields = recorded.split("\0");
      // Every field is terminated rather than separated, so the last split is
      // the empty tail after the final NUL and not an argument.
      fields.pop();

      const parsed: string[][] = [];
      for (const field of fields) {
        if (field === CALL_SEPARATOR) {
          parsed.push([]);
          continue;
        }
        parsed.at(-1)?.push(field);
      }
      return parsed;
    },
  };
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

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** What marks the start of one recorded invocation in the record. */
const CALL_SEPARATOR = "--- call ---";

/** A binary that was on PATH, and how it was called while it was. */
export interface RecordedCalls {
  /** Every invocation, as its argument list, in the order they happened. */
  calls(): Promise<string[][]>;
}

/**
 * Puts a binary named `name` on PATH for the length of the test and records
 * how it was called. `body` is the script's, minus the shebang, and decides
 * what each invocation answers with — its stdout, stderr and exit code.
 *
 * What a caller owes the developer is checked against the arguments it was
 * given rather than a real invocation, which would either leave something
 * behind on every run (a pull request, a container) or need a credential and
 * a network the test suite doesn't have.
 *
 * Arguments are recorded NUL-separated rather than one per line, because the
 * argument worth asserting about is often several lines — a `--body`, a
 * prompt. Split on newlines, every assertion about one would silently be an
 * assertion about its first line.
 */
export async function recordingBinary(
  t: { after: (fn: () => void) => void },
  name: string,
  body: string,
): Promise<RecordedCalls> {
  const path_ = process.env["PATH"];

  const bin = await mkdtemp(path.join(tmpdir(), `${name}-recording-`));
  const calls = path.join(bin, "calls");
  await writeFile(
    path.join(bin, name),
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

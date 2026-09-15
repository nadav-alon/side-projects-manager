import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** What marks the start of one recorded invocation in the record. */
const CALL_SEPARATOR = "--- call ---";

/** The `docker` that was on PATH, and how it was called while it was. */
export interface RecordedDocker {
  /** Every invocation, as its argument list, in the order they happened. */
  calls(): Promise<string[][]>;
}

/**
 * Puts a `docker` on PATH for the length of the test and records how it was
 * called. `body` is the script's, minus the shebang, and decides what each
 * invocation answers with — its stdout, stderr and exit code.
 *
 * `dockerCommand` builds the argument list docker is invoked with, and
 * `readAgentRun`/`readExitedRun`/`dockerNeverRan` decide what the adapter
 * makes of what came back; none of the four is exported, since nothing calls
 * them but `dockerContainer` itself. A test reaches them the way any caller
 * does: through `containerSandbox()`'s own default container, with `docker`
 * on PATH standing in for the real thing.
 */
export async function recordingDocker(
  t: { after: (fn: () => void) => void },
  body: string,
): Promise<RecordedDocker> {
  const path_ = process.env["PATH"];

  const bin = await mkdtemp(path.join(tmpdir(), "docker-recording-"));
  const calls = path.join(bin, "calls");
  await writeFile(
    path.join(bin, "docker"),
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

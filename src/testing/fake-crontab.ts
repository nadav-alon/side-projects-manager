import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A `crontab` binary in a fresh directory, answering `-l` with `lines` joined
 * by newlines, or exiting non-zero — as the real `crontab -l` does when the
 * user has none — when `lines` is undefined.
 *
 * Returns the directory to put ahead of `PATH`, for a test that shells out to
 * `crontab` itself, in-process, or in a spawned child.
 */
export async function fakeCrontabBin(lines?: readonly string[]): Promise<string> {
  const bin = await mkdtemp(path.join(tmpdir(), "fake-crontab-"));
  const script =
    lines === undefined
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`;
  await writeFile(path.join(bin, "crontab"), script, { mode: 0o755 });
  return bin;
}

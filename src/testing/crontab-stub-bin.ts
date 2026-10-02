import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CRON_MARKER } from "../adapters/system-trigger-registrations.ts";

/**
 * A `crontab` binary in a fresh directory, answering `-l` with `lines` joined
 * by newlines, or exiting non-zero — as the real `crontab -l` does when the
 * user has none — when `lines` is undefined.
 *
 * A stub, not a Fake (CONTEXT.md: Fake) — it stands in for the `crontab`
 * binary the adapter shells out to, not for a port. `FakeTriggerRegistrations`
 * is the port's Fake.
 *
 * Returns the directory to put ahead of `PATH`, for a test that shells out to
 * `crontab` itself, in-process, or in a spawned child.
 */
export async function crontabStubBin(lines?: readonly string[]): Promise<string> {
  const bin = await mkdtemp(path.join(tmpdir(), "crontab-stub-"));
  const script =
    lines === undefined
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`;
  await writeFile(path.join(bin, "crontab"), script, { mode: 0o755 });
  return bin;
}

/**
 * A registered schedule cron line pointing at `home`, quoting
 * `morning-run.ts` exactly as `scripts/install-triggers.sh` does — down to
 * the marker, `CRON_MARKER`, imported rather than copied so this cannot
 * drift from what the adapter actually reads by. `marker` is overridable to
 * build a line carrying a stale one instead.
 */
export function cronLine(home: string, marker: string = CRON_MARKER): string {
  return `*/15 * * * * set -a; . "/home/dev/.side-projects-manager.env"; set +a; export PATH="/usr/local/bin:/usr/bin:/bin"; git -C "${home}" pull --ff-only -q >> "${home}/trigger.log" 2>&1; /usr/bin/node "${home}/src/bin/morning-run.ts" >> "${home}/trigger.log" 2>&1 ${marker}`;
}

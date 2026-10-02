import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isCronStep } from "../ports/index.ts";
import type {
  ScheduleRegistration,
  TriggerRegistration,
  TriggerRegistrations,
} from "../trigger-registrations.ts";
import { isErrorWithCode } from "./error-code.ts";

const execFileAsync = promisify(execFile);

/**
 * Exactly what `scripts/install-triggers.sh` writes at the end of the cron
 * line it manages. Exported so a test can build a fixture from the same
 * value this reads by, rather than a copy that can drift from it unnoticed.
 */
export const CRON_MARKER =
  "# side-projects-manager: schedule (see scripts/install-triggers.sh)";

/**
 * Exactly what `scripts/install-triggers.sh` delimits a logon-guard block
 * with. Exported for the same reason as `CRON_MARKER`.
 */
export const RC_BEGIN = "# >>> side-projects-manager: logon guard >>>";
export const RC_END = "# <<< side-projects-manager: logon guard <<<";

/**
 * The tail every registered line quotes the trigger script as —
 * `install-triggers.sh`'s own `$TRIGGER_SCRIPT`, minus the manager home it is
 * joined to. Matches both the current name and `guarded-morning-run.ts`, the
 * name every installer from `d8d4439` through `b06aab9` wrote before the
 * invocation lease was folded into `morning-run.ts` itself — a block or line
 * from one of those installs is still on disk until the installer is re-run.
 */
const TRIGGER_SCRIPT_SUFFIX = /\/src\/bin\/(?:guarded-)?morning-run\.ts$/;

/** A cron minute field naming a step — star, slash, then the step itself, captured. */
const STEP_FIELD = /^\*\/(\d+)$/;

const DEFAULT_RC_FILES = [
  path.join(os.homedir(), ".bashrc"),
  path.join(os.homedir(), ".zshrc"),
];

/**
 * Reads the crontab and the shell rc files for what `install-triggers.sh`
 * leaves behind, by the same markers it writes them with. Read-only: neither
 * is written here, and a registration this finds stale — pointing at a home
 * that no longer exists, or missing outright — is left for the installer to
 * fix, not fixed here.
 *
 * `rcFiles` defaults to the developer's own `.bashrc` and `.zshrc`,
 * overridable for a test.
 */
export function systemTriggerRegistrations(
  rcFiles: readonly string[] = DEFAULT_RC_FILES,
): TriggerRegistrations {
  return {
    async schedule(): Promise<ScheduleRegistration> {
      const line = (await crontabLines()).find((candidate) =>
        candidate.trimEnd().endsWith(CRON_MARKER),
      );
      if (line === undefined) {
        return { registered: false };
      }
      const managerHome = managerHomeIn(line);
      const step = STEP_FIELD.exec(line.trim().split(/\s+/)[0]!)?.[1];
      if (managerHome === undefined || step === undefined || !isCronStep(step)) {
        return { registered: false };
      }
      return { registered: true, managerHome, step };
    },

    async logonGuard(): Promise<TriggerRegistration> {
      for (const rcFile of rcFiles) {
        const content = await readRcFile(rcFile);
        if (content === undefined) {
          continue;
        }
        const block = firstLogonGuardBlock(content);
        if (block === undefined) {
          continue;
        }
        const managerHome = managerHomeIn(block);
        return managerHome === undefined
          ? { registered: false }
          : { registered: true, managerHome };
      }
      return { registered: false };
    },
  };
}

/** Every line of the current user's crontab, or none when there isn't one — the same tolerance `install-triggers.sh`'s own `crontab -l 2>/dev/null || true` gives it. */
async function crontabLines(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"]);
    return stdout.split("\n");
  } catch {
    return [];
  }
}

async function readRcFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The lines between the first `RC_BEGIN`/`RC_END` pair in `content`, if any —
 * the first of the two when an older install left the block behind twice,
 * since both still name the same manager home.
 */
function firstLogonGuardBlock(content: string): string | undefined {
  const lines = content.split("\n");
  const begin = lines.indexOf(RC_BEGIN);
  if (begin === -1) {
    return undefined;
  }
  const end = lines.indexOf(RC_END, begin + 1);
  if (end === -1) {
    return undefined;
  }
  return lines.slice(begin + 1, end).join("\n");
}

/** The manager home a registered line or block points at, read off its quoted trigger-script path. */
function managerHomeIn(text: string): string | undefined {
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  for (const candidate of quoted) {
    const match = TRIGGER_SCRIPT_SUFFIX.exec(candidate);
    if (match !== null) {
      return candidate.slice(0, match.index);
    }
  }
  return undefined;
}

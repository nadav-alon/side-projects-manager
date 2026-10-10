// Dependency-free beyond its two sibling imports, because `scripts/verify-harness.ts` runs
// it inside the built image, where nothing else of `src/` is mounted.

import type { Branch } from "../ports/branch.ts";
import { FORCE_PUSH_RUN_KINDS } from "../ports/sandbox.ts";

/**
 * The settings the agent CLI is handed for every run, whatever the project's
 * `.claude/settings.json` says: its own sandbox is off. That setting serves
 * the developer's interactive sessions; here the container is the boundary,
 * and the image has neither bubblewrap nor socat, so a project demanding the
 * sandbox would have every run exit before its first tool call.
 * `failIfUnavailable` is overridden too, so the run does not lean on it being
 * inert while `enabled` is false. `--settings` outranks the project's file
 * without editing it, and a project with no `sandbox` block is unaffected.
 */
const CLI_SETTINGS_SANDBOX = { enabled: false, failIfUnavailable: false };

/**
 * The deny rules the manager hands every run, whatever the project's own
 * `.claude/settings.json` denies — or does not: a project with an empty one
 * is protected the same. They replace the project's for merging and pushing:
 * a project's rules can pull against a run's contract (a rebase must
 * force-push), and a manager that outranks them has to carry its own.
 * Carried in `--settings` rather than baked into the image, so they travel
 * with the manager and need no image rebuild to change.
 *
 * Refused to every run: `gh pr merge`, a push to `base`, and a force-push.
 * A kind in `FORCE_PUSH_RUN_KINDS` is refused `--force` alone, leaving it
 * `--force-with-lease`. Each rule is a fixed string, so a denial's rule can
 * be named in the hand-back (`ruleDenying`).
 */
export function managerDenyRules(kind: string, base: Branch): string[] {
  const forcePush = FORCE_PUSH_RUN_KINDS.includes(kind)
    ? ["Bash(git push --force)", "Bash(git push --force *)"]
    : ["Bash(git push --force*)"];
  return [
    "Bash(gh pr merge*)",
    `Bash(git push origin ${base})`,
    `Bash(git push origin HEAD:${base})`,
    ...forcePush,
  ];
}

/** The settings the agent CLI is handed for a run of `kind` against `base`. */
export function cliSettings(kind: string, base: Branch): string {
  return JSON.stringify({
    sandbox: CLI_SETTINGS_SANDBOX,
    permissions: { deny: managerDenyRules(kind, base) },
  });
}

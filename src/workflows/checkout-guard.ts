import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

/** One workflow file's own source, however it was read. */
export interface WorkflowSource {
  /** The workflow's path relative to the repo root — named in a failure. */
  path: string;
  content: string;
}

/** A job whose checked-in script step breaks one of the rules below. */
export interface CheckoutGuardFailure {
  workflow: string;
  job: string;
  reason: string;
}

const SCRIPT_UNDER_WORKFLOWS = /\.github\/workflows\/scripts\/\S+/;
const CHECKOUT_ACTION = /^actions\/checkout@/;

interface WorkflowStep {
  uses?: string;
  run?: string;
}

/** A `permissions:` block, either the `{ contents: read }` mapping form or the `read-all`/`write-all` shorthand. */
type WorkflowPermissions = Record<string, string> | string;

interface WorkflowJob {
  permissions?: WorkflowPermissions;
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  permissions?: WorkflowPermissions;
  jobs?: Record<string, WorkflowJob>;
}

/**
 * Whether `permissions` gives its job read access to the repo's contents —
 * what `actions/checkout` needs. `write` grants it too, the same way GitHub
 * Actions resolves the scope: a token permitted to write a resource can read
 * it.
 */
function grantsContentsRead(permissions: WorkflowPermissions | undefined): boolean {
  if (typeof permissions === "string") {
    return permissions === "read-all" || permissions === "write-all";
  }
  const contents = permissions?.contents;
  return contents === "read" || contents === "write";
}

/**
 * Every rule a checked-in-script step is held to, checked against one
 * workflow file's own YAML: a job that runs a path under
 * `.github/workflows/scripts/` needs an `actions/checkout` step earlier in
 * the same job, and permissions that grant it read access to the repo's
 * contents — its own `permissions:` block if it has one, the workflow's
 * otherwise, the same way GitHub Actions itself resolves a job's effective
 * permissions (a job's block replaces the workflow's rather than adding to
 * it).
 *
 * Nothing else about the YAML is checked; a file that doesn't parse to a
 * mapping of jobs is treated as having none.
 */
export function checkoutGuardFailures(source: WorkflowSource): CheckoutGuardFailure[] {
  const document = parseYaml(source.content) as WorkflowDocument | null;
  const jobs = document?.jobs ?? {};
  const failures: CheckoutGuardFailure[] = [];

  for (const [jobId, job] of Object.entries(jobs)) {
    let checkedOut = false;
    let runsScript = false;

    for (const step of job.steps ?? []) {
      if (step.uses !== undefined && CHECKOUT_ACTION.test(step.uses)) {
        checkedOut = true;
        continue;
      }
      if (step.run !== undefined && SCRIPT_UNDER_WORKFLOWS.test(step.run)) {
        runsScript = true;
        if (!checkedOut) {
          failures.push({
            workflow: source.path,
            job: jobId,
            reason: "runs a checked-in script with no earlier actions/checkout step",
          });
          break;
        }
      }
    }

    if (!runsScript) {
      continue;
    }

    const permissions = job.permissions ?? document?.permissions;
    if (!grantsContentsRead(permissions)) {
      failures.push({
        workflow: source.path,
        job: jobId,
        reason: 'runs a checked-in script without "contents: read" among its permissions',
      });
    }
  }

  return failures;
}

/** Every `.github/workflows/*.yml` file's own source, read from `root`. */
export async function repoWorkflowSources(root: string): Promise<WorkflowSource[]> {
  const dir = path.join(root, ".github", "workflows");
  const entries = await readdir(dir, { withFileTypes: true });
  const sources: WorkflowSource[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) {
      continue;
    }
    sources.push({
      path: path.join(".github", "workflows", entry.name),
      content: await readFile(path.join(dir, entry.name), "utf8"),
    });
  }
  return sources;
}

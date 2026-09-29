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

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  jobs?: Record<string, WorkflowJob>;
}

/**
 * Every rule #1048 wants a checked-in-script step held to, checked against
 * one workflow file's own YAML: a job that runs a path under
 * `.github/workflows/scripts/` needs an `actions/checkout` step earlier in
 * the same job.
 *
 * Anything else about the YAML — actionlint-style linting — is out of scope
 * (#1048); a file that doesn't parse to a mapping of jobs is treated as
 * having none.
 */
export function checkoutGuardFailures(source: WorkflowSource): CheckoutGuardFailure[] {
  const document = parseYaml(source.content) as WorkflowDocument | null;
  const jobs = document?.jobs ?? {};
  const failures: CheckoutGuardFailure[] = [];

  for (const [jobId, job] of Object.entries(jobs)) {
    let checkedOut = false;

    for (const step of job.steps ?? []) {
      if (step.uses !== undefined && CHECKOUT_ACTION.test(step.uses)) {
        checkedOut = true;
        continue;
      }
      if (step.run !== undefined && SCRIPT_UNDER_WORKFLOWS.test(step.run) && !checkedOut) {
        failures.push({
          workflow: source.path,
          job: jobId,
          reason: "runs a checked-in script with no earlier actions/checkout step",
        });
        break;
      }
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

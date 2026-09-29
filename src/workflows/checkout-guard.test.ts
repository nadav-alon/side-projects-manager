import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { checkout } from "../ports/checkout.ts";
import { tempHome } from "../testing/index.ts";
import {
  CHECKOUT_GUARD_REASONS,
  checkoutGuardFailures,
  repoWorkflowSources,
  type WorkflowSource,
} from "./checkout-guard.ts";

/** This repo's own checkout, from `src/workflows` or its built `dist/workflows`. */
const REPO_CHECKOUT = checkout(path.join(import.meta.dirname, "..", ".."));

/** A minimal workflow: one job, one `steps` list, everything else filled in around it. */
function workflow(
  steps: string[],
  options: { permissions?: string; jobPermissions?: string } = {},
): WorkflowSource {
  return {
    path: "example.yml",
    content: [
      "name: Example",
      "permissions:",
      `  ${options.permissions ?? "contents: read"}`,
      "jobs:",
      "  demo:",
      "    runs-on: ubuntu-latest",
      ...(options.jobPermissions !== undefined
        ? ["    permissions:", `      ${options.jobPermissions}`]
        : []),
      "    steps:",
      ...steps.map((step) => `      ${step}`),
      "",
    ].join("\n"),
  };
}

const RUNS_SCRIPT = "- run: bash .github/workflows/scripts/example.sh";
const CHECKS_OUT = "- uses: actions/checkout@v5";

describe("checkoutGuardFailures", () => {
  it("ignores a job that runs no checked-in script", () => {
    assert.deepEqual(checkoutGuardFailures(workflow(["- run: npm test"])), []);
  });

  it("fails a job that runs a checked-in script with no earlier checkout step, naming the workflow and the job", () => {
    assert.deepEqual(checkoutGuardFailures(workflow([RUNS_SCRIPT])), [
      {
        workflow: "example.yml",
        job: "demo",
        reason: CHECKOUT_GUARD_REASONS.noCheckout,
      },
    ]);
  });

  it("passes once a checkout step precedes the script step", () => {
    assert.deepEqual(checkoutGuardFailures(workflow([CHECKS_OUT, RUNS_SCRIPT])), []);
  });

  it("still fails a script step that precedes the job's checkout step", () => {
    assert.deepEqual(checkoutGuardFailures(workflow([RUNS_SCRIPT, CHECKS_OUT])), [
      {
        workflow: "example.yml",
        job: "demo",
        reason: CHECKOUT_GUARD_REASONS.noCheckout,
      },
    ]);
  });

  it("fails a job with no contents: read among its permissions, naming the workflow and the job", () => {
    const source = workflow([CHECKS_OUT, RUNS_SCRIPT], { permissions: "issues: write" });

    assert.deepEqual(checkoutGuardFailures(source), [
      {
        workflow: "example.yml",
        job: "demo",
        reason: CHECKOUT_GUARD_REASONS.noContentsRead,
      },
    ]);
  });

  it("reads a job's permissions from the workflow's own when the job sets none itself", () => {
    const source = workflow([CHECKS_OUT, RUNS_SCRIPT], { permissions: "contents: read" });

    assert.deepEqual(checkoutGuardFailures(source), []);
  });

  it("accepts contents: write, since it grants read access too", () => {
    const source = workflow([CHECKS_OUT, RUNS_SCRIPT], { permissions: "contents: write" });

    assert.deepEqual(checkoutGuardFailures(source), []);
  });

  it("accepts the read-all and write-all shorthand for a workflow's permissions", () => {
    for (const shorthand of ["read-all", "write-all"]) {
      const source: WorkflowSource = {
        path: "example.yml",
        content: [
          "name: Example",
          `permissions: ${shorthand}`,
          "jobs:",
          "  demo:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          `      ${CHECKS_OUT}`,
          `      ${RUNS_SCRIPT}`,
          "",
        ].join("\n"),
      };

      assert.deepEqual(checkoutGuardFailures(source), []);
    }
  });

  it("prefers a job's own permissions over the workflow's, the same way GitHub Actions resolves them", () => {
    const source = workflow([CHECKS_OUT, RUNS_SCRIPT], {
      permissions: "contents: read",
      jobPermissions: "issues: write",
    });

    assert.deepEqual(checkoutGuardFailures(source), [
      {
        workflow: "example.yml",
        job: "demo",
        reason: CHECKOUT_GUARD_REASONS.noContentsRead,
      },
    ]);
  });
});

describe("repoWorkflowSources", () => {
  it("finds no job across this repo's own workflows that runs a checked-in script unguarded", async () => {
    const sources = await repoWorkflowSources(REPO_CHECKOUT);

    assert.ok(sources.length > 0);
    assert.deepEqual(sources.flatMap(checkoutGuardFailures), []);
  });

  it("picks up a .yaml workflow alongside a .yml one and fails both the same way", async () => {
    const root = await tempHome("checkout-guard");
    const dir = path.join(root, ".github", "workflows");
    await mkdir(dir, { recursive: true });
    const { content } = workflow([RUNS_SCRIPT]);
    await writeFile(path.join(dir, "example.yml"), content);
    await writeFile(path.join(dir, "example.yaml"), content);
    await writeFile(path.join(dir, "notes.txt"), content);

    const sources = await repoWorkflowSources(checkout(root));

    assert.deepEqual(sources.map((source) => source.path).sort(), [
      path.join(".github", "workflows", "example.yaml"),
      path.join(".github", "workflows", "example.yml"),
    ]);
    const failuresOf = (extension: string) =>
      sources
        .filter((source) => source.path.endsWith(extension))
        .flatMap(checkoutGuardFailures)
        .map(({ job, reason }) => ({ job, reason }));
    assert.deepEqual(failuresOf(".yaml"), [
      { job: "demo", reason: CHECKOUT_GUARD_REASONS.noCheckout },
    ]);
    assert.deepEqual(failuresOf(".yaml"), failuresOf(".yml"));
  });
});

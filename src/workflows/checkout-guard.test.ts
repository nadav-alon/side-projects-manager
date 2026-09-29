import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { checkoutGuardFailures, repoWorkflowSources, type WorkflowSource } from "./checkout-guard.ts";

/** The checkout root, from `src/workflows` or its built `dist/workflows`. */
const CHECKOUT_ROOT = path.join(import.meta.dirname, "..", "..");

/** A minimal workflow: one job, one `steps` list, everything else filled in around it. */
function workflow(steps: string[], options: { permissions?: string } = {}): WorkflowSource {
  return {
    path: "example.yml",
    content: [
      "name: Example",
      "permissions:",
      `  ${options.permissions ?? "contents: read"}`,
      "jobs:",
      "  demo:",
      "    runs-on: ubuntu-latest",
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
        reason: "runs a checked-in script with no earlier actions/checkout step",
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
        reason: "runs a checked-in script with no earlier actions/checkout step",
      },
    ]);
  });

  it("fails a job with no contents: read among its permissions, naming the workflow and the job", () => {
    const source = workflow([CHECKS_OUT, RUNS_SCRIPT], { permissions: "issues: write" });

    assert.deepEqual(checkoutGuardFailures(source), [
      {
        workflow: "example.yml",
        job: "demo",
        reason: 'runs a checked-in script without "contents: read" among its permissions',
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
    const source: WorkflowSource = {
      path: "example.yml",
      content: [
        "name: Example",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  demo:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      issues: write",
        "    steps:",
        `      ${CHECKS_OUT}`,
        `      ${RUNS_SCRIPT}`,
        "",
      ].join("\n"),
    };

    assert.deepEqual(checkoutGuardFailures(source), [
      {
        workflow: "example.yml",
        job: "demo",
        reason: 'runs a checked-in script without "contents: read" among its permissions',
      },
    ]);
  });
});

describe("repoWorkflowSources", () => {
  it("finds no job across this repo's own workflows that runs a checked-in script unguarded", async () => {
    const sources = await repoWorkflowSources(CHECKOUT_ROOT);

    assert.ok(sources.length > 0);
    assert.deepEqual(sources.flatMap(checkoutGuardFailures), []);
  });
});

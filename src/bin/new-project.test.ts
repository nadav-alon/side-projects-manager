import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "new-project.ts");

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The command with whatever arguments a test gives it.
 *
 * Only the arguments are exercised here. Everything past them reaches GitHub
 * and then the developer's own terminal, and is covered at the seam in
 * `src/new-project.test.ts` instead.
 */
async function run(...args: string[]): Promise<Result> {
  return execFileAsync(process.execPath, [entryPoint, ...args]).then(
    (result) => ({ ...result, code: 0 }),
    (error: Result) => error,
  );
}

describe("the new-project command", () => {
  it("asks for a repo when given none, and shows how to call it", async () => {
    const { stderr, code } = await run();

    assert.equal(code, 1);
    assert.match(stderr, /a repo to start is required/);
    assert.match(stderr, /Usage: new-project <owner\/repo>/);
  });

  it("refuses a name that is not a repo slug, naming it", async () => {
    const { stderr, code } = await run("pilot");

    assert.equal(code, 1);
    assert.match(stderr, /new-project failed: .*owner\/repo.*"pilot"/);
    assert.doesNotMatch(stderr, /\n\s+at /);
  });

  it("accepts --public as a flag, not a positional", async () => {
    const { stderr, code } = await run("--public");

    assert.equal(code, 1);
    assert.match(stderr, /a repo to start is required/);
  });

  it("tells the developer to quote a description it was handed loose", async () => {
    const { stderr, code } = await run(
      "nadav-alon/pilot",
      "A flight log",
      "that files itself",
    );

    assert.equal(code, 1);
    assert.match(stderr, /quote the description/);
  });
});

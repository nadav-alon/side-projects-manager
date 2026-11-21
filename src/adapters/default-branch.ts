import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type Branch, isBranch } from "../ports/branch.ts";
import type { Checkout } from "../ports/checkout.ts";

const run = promisify(execFile);

/**
 * The default branch the remote names (`origin/HEAD`), whatever the
 * checkout's own HEAD points at. A checkout whose remote names none (one not
 * made by `git clone`) is refused rather than guessed at.
 */
export async function remoteDefaultBranch(checkout: Checkout): Promise<Branch> {
  let name: string;
  try {
    const { stdout } = await run("git", [
      "-C",
      checkout,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    name = stdout.trim().replace(/^origin\//, "");
  } catch {
    throw new Error(
      `${checkout} has no origin/HEAD, so its default branch is unknown.`,
    );
  }
  if (!isBranch(name)) {
    throw new TypeError(
      `origin/HEAD names a branch this adapter cannot use: ${name}`,
    );
  }
  return name;
}

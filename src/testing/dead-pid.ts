import { spawnSync } from "node:child_process";

import { processId, type ProcessId } from "../ports/index.ts";

/** A pid guaranteed no longer alive: a child process that has already exited. */
export function deadPid(): ProcessId {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) {
    throw new Error("failed to spawn a child process for its pid");
  }
  return processId(child.pid);
}

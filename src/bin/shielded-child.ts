import { spawn } from "node:child_process";
import { constants } from "node:os";

/** The signals a morning is stopped with: Ctrl+C, and a service manager's stop. */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Runs `args` under this node binary in a process group of its own, passes on
 * every stop signal this process receives, and settles with its exit code.
 *
 * A group of its own because Ctrl+C signals the terminal's whole foreground
 * group: every docker, git and gh process a morning has started would die with
 * it, before the loop could let one finish. Shielded, the child hears a stop
 * only as this process passes it on, and decides for itself what it means.
 */
export function runShielded(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, ...args], {
      stdio: "inherit",
      detached: true,
      env,
    });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    const unforward = (): void => {
      for (const signal of STOP_SIGNALS) {
        process.off(signal, forward);
      }
    };
    for (const signal of STOP_SIGNALS) {
      process.on(signal, forward);
    }
    child.on("error", (error) => {
      unforward();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      unforward();
      // Ended by a signal, as a shell reports it: 128 plus its number.
      resolve(signal === null ? code : 128 + constants.signals[signal]);
    });
  });
}

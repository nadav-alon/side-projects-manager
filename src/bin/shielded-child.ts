import { spawn } from "node:child_process";
import { constants } from "node:os";

/**
 * The signals a morning is stopped with: Ctrl+C, a service manager's stop, and
 * the hangup of a terminal that was closed with the morning still running.
 */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Runs `args` under this node binary in a process group of its own, passes on
 * every stop signal this process receives, and settles with its exit code.
 *
 * A group of its own because Ctrl+C signals the terminal's whole foreground
 * group: every docker, git and gh process a morning has started would die with
 * it, before the loop could let one finish. Shielded, the child hears a stop
 * only as this process passes it on, and decides for itself what it means.
 *
 * Shielded also means out of the terminal's session, so nothing but this
 * process can stop the child. The child is connected to it by a channel, and
 * reads that channel closing — this process killed outright — as a stop too
 * (see `onShieldGone`), rather than running on with nobody able to stop it.
 */
export function runShielded(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, ...args], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
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
    // Itself shielded, and its own shield gone: the child is told to stop the
    // way this process would have been.
    onShieldGone(() => forward("SIGTERM"));
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

/**
 * Calls `stop` once if the process shielding this one dies before it does. A
 * process nothing shields — started by hand — never calls it.
 */
export function onShieldGone(stop: () => void): void {
  if (process.channel === undefined) {
    return;
  }
  process.once("disconnect", stop);
  // The channel is only ever closed, never written to: listening on it must not
  // keep this process alive once its own work is done. After the listener,
  // since adding one refs the channel again.
  process.channel.unref();
}

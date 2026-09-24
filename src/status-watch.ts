import { milliseconds, type Milliseconds } from "./ports/index.ts";

/** One redraw's worth of report lines, and whether an invocation is still open. */
export interface WatchFrame {
  readonly lines: readonly string[];
  readonly inFlight: boolean;
}

/**
 * What `watchStatus` needs from its caller: how to produce the next frame,
 * how to wait between them, and where to put a frame once drawn. Real time
 * and the real report stay out of this module so the loop itself — cadence,
 * and the exit-when-it-closes rule — is testable without either.
 */
export interface WatchPorts {
  render(): Promise<WatchFrame>;
  sleep(interval: Milliseconds, signal: AbortSignal): Promise<void>;
  display(lines: readonly string[]): void;
}

/**
 * Redraws `ports.render()`'s report every `interval` until `signal` aborts
 * (Ctrl+C), or until an invocation that was already in flight on the first
 * draw closes — whichever comes first. Nothing in flight on the first draw
 * never triggers that second exit: a run may start on a later hourly firing,
 * so the watch just keeps going until interrupted.
 */
export async function watchStatus(
  ports: WatchPorts,
  interval: Milliseconds,
  signal: AbortSignal,
): Promise<void> {
  let sawInFlight = false;
  let first = true;
  while (!signal.aborted) {
    const frame = await ports.render();
    if (first) {
      sawInFlight = frame.inFlight;
      first = false;
    }
    ports.display(frame.lines);
    if (sawInFlight && !frame.inFlight) {
      return;
    }
    if (signal.aborted) {
      return;
    }
    await ports.sleep(interval, signal);
  }
}

export type WatchArg =
  | { readonly kind: "disabled" }
  | { readonly kind: "enabled"; readonly interval: Milliseconds }
  | { readonly kind: "invalid"; readonly message: string };

/** How often `status --watch` redraws when given no seconds of its own. */
const DEFAULT_WATCH_SECONDS = 30;

const WATCH_FLAG = "--watch";

/**
 * Reads `--watch` (default {@link DEFAULT_WATCH_SECONDS}s) or `--watch N` off
 * the command line. `N` must be a positive whole number of seconds: the
 * grain a redraw happens at, not a duration a fraction of a second could ever
 * matter for.
 */
export function parseWatchArg(argv: readonly string[]): WatchArg {
  const index = argv.indexOf(WATCH_FLAG);
  if (index === -1) {
    return { kind: "disabled" };
  }
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    return { kind: "enabled", interval: milliseconds(DEFAULT_WATCH_SECONDS * 1000) };
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return {
      kind: "invalid",
      message: `--watch expects a positive whole number of seconds, got "${raw}".`,
    };
  }
  return { kind: "enabled", interval: milliseconds(seconds * 1000) };
}

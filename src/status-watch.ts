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
 * never triggers that second exit: an invocation may start on a later hourly firing,
 * so the watch just keeps going until interrupted.
 */
export async function watchStatus(
  ports: WatchPorts,
  interval: Milliseconds,
  signal: AbortSignal,
): Promise<void> {
  let inFlightAtStart: boolean | undefined;
  while (!signal.aborted) {
    const frame = await ports.render();
    inFlightAtStart ??= frame.inFlight;
    ports.display(frame.lines);
    if (inFlightAtStart && !frame.inFlight) {
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
const DEFAULT_WATCH_INTERVAL: Milliseconds = milliseconds(30_000);

const WATCH_FLAG = "--watch";

/** The longest interval `--watch N` accepts — comfortably under `setTimeout`'s ~24.8-day limit. */
const MAX_WATCH_SECONDS = 86_400;

/** Whole digits only: rejects the hex (`0x10`) and exponential (`1e1`) forms `Number` would otherwise accept. */
const WHOLE_NUMBER = /^\d+$/;

/**
 * Reads `--watch` (default {@link DEFAULT_WATCH_INTERVAL}) or `--watch N` off
 * the command line. `N` must be a positive whole number of seconds, written
 * in plain digits, of at most {@link MAX_WATCH_SECONDS}: the grain a redraw
 * happens at, not a duration a fraction of a second could ever matter for.
 */
export function parseWatchArg(argv: readonly string[]): WatchArg {
  const index = argv.indexOf(WATCH_FLAG);
  if (index === -1) {
    return { kind: "disabled" };
  }
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    return { kind: "enabled", interval: DEFAULT_WATCH_INTERVAL };
  }
  const seconds = Number(raw);
  if (!WHOLE_NUMBER.test(raw) || seconds <= 0 || seconds > MAX_WATCH_SECONDS) {
    return {
      kind: "invalid",
      message: `--watch expects a positive whole number of seconds, up to ${MAX_WATCH_SECONDS}, got "${raw}".`,
    };
  }
  return { kind: "enabled", interval: milliseconds(seconds * 1000) };
}

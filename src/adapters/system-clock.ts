import type { Clock } from "../ports/index.ts";

/** The wall clock. The one port whose real implementation is this small. */
export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
};

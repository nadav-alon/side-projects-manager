/**
 * The four kinds a discovery may carry, in the order CONTEXT.md's "Discovery"
 * lists them: a correction and a prerequisite are blocking, a clarification
 * and a suggestion are advisory. The kind alone decides which — a discovery
 * carries no severity of its own.
 */
export const DISCOVERY_KINDS = [
  "correction",
  "prerequisite",
  "clarification",
  "suggestion",
] as const;

export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number];

/**
 * Something a run's agent learned about its ticket that the developer has to
 * act on — see CONTEXT.md's "Discovery". Carries no severity of its own (the
 * kind decides it) and no issue number: which ticket a discovery lands
 * against is the manager's call, never the agent's.
 */
export interface Discovery {
  kind: DiscoveryKind;
  /** One line naming what was found. */
  title: string;
  /** The discovery itself, in the agent's own words. */
  body: string;
}

/**
 * Whether `kind` stops the run rather than merely riding alongside a run that
 * finishes: a correction (the ticket is wrong) or a prerequisite (the work
 * needs something nobody ticketed) — see CONTEXT.md's "Discovery".
 */
export function isBlockingDiscoveryKind(kind: DiscoveryKind): boolean {
  return kind === "correction" || kind === "prerequisite";
}

function isDiscoveryKind(value: unknown): value is DiscoveryKind {
  return (
    typeof value === "string" &&
    (DISCOVERY_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Whether `value` is a well-formed discovery: one of the four kinds, and a
 * non-empty title and body. What a discovery file must parse as to count —
 * anything else is dropped and counted rather than failing the run (see
 * `container-sandbox.ts`'s `readDiscoveries`).
 */
export function isDiscovery(value: unknown): value is Discovery {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { kind, title, body } = value as {
    kind?: unknown;
    title?: unknown;
    body?: unknown;
  };
  return (
    isDiscoveryKind(kind) &&
    typeof title === "string" &&
    title !== "" &&
    typeof body === "string" &&
    body !== ""
  );
}

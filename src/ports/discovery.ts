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
  /**
   * Declares the discovery a **ready discovery**, per CONTEXT.md: it leaves
   * no decision to the developer, so the ticket it opens may skip triage.
   * Only ever read on a prerequisite or a suggestion — a correction or a
   * clarification never opens a ticket, so this is ignored on either, per
   * `discovery-routing.ts`. Absent or `false` leaves today's behavior in
   * place; declaring `ready` is not by itself enough — `discovery-routing.ts`
   * still checks the body reads as an agent brief and that the ticket the
   * filer is working was not itself born from a ready discovery.
   */
  ready?: boolean;
}

function isDiscoveryKind(value: unknown): value is DiscoveryKind {
  return (
    typeof value === "string" &&
    (DISCOVERY_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Whether `value` is a well-formed discovery: one of the four kinds, a title
 * and a body, and a `ready` that is either absent or a boolean. What a
 * discovery file must parse as to count — anything else is dropped and
 * counted rather than failing the run (see `container-sandbox.ts`'s
 * `readDiscoveries`). Silent on whether either string is empty:
 * `DISCOVERY_INSTRUCTIONS` never asks the agent for a non-empty one, so
 * nothing here can hold it to that.
 */
export function isDiscovery(value: unknown): value is Discovery {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { kind, title, body, ready } = value as {
    kind?: unknown;
    title?: unknown;
    body?: unknown;
    ready?: unknown;
  };
  return (
    isDiscoveryKind(kind) &&
    typeof title === "string" &&
    typeof body === "string" &&
    (ready === undefined || typeof ready === "boolean")
  );
}

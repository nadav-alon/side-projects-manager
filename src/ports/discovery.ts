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
   * `discovery-routing.ts`. Absent or `false` opens the ticket needs-triage,
   * as any other discovery does; declaring `ready` is not by itself enough —
   * `discovery-routing.ts` still checks the body reads as an agent brief and
   * that the ticket the discovery is filed against was not itself born from
   * a ready discovery.
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
 * and a body. What a discovery file must parse as to count — anything else is
 * dropped and counted rather than failing the run (see
 * `container-sandbox.ts`'s `readDiscoveries`). Silent on whether either
 * string is empty: `DISCOVERY_INSTRUCTIONS` never asks the agent for a
 * non-empty one, so nothing here can hold it to that.
 *
 * `ready` is not checked here, deliberately: it is optional and additive, so
 * a malformed value — a non-boolean an agent handwrote into the JSON — should
 * cost the discovery its ready state, not the whole discovery, blocking kinds
 * included. `readDiscoveries` reads `ready` itself, keeping only `=== true`.
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
    isDiscoveryKind(kind) && typeof title === "string" && typeof body === "string"
  );
}

/**
 * The `Discovery` a validated `value` carries, field by field, and nothing
 * else: `value` is only typed as a `Discovery` by `isDiscovery`'s say-so, so
 * the JSON it came from may still carry keys `Discovery` never declared, and
 * those must not survive into the object callers act on. Declared beside
 * `Discovery` and `isDiscovery` so the two stay in step: `fields` is typed
 * `Record<keyof Discovery, unknown>`, which requires a value for every key
 * `Discovery` has, so a field added to the interface and not copied here
 * fails to compile rather than being dropped silently the way
 * `container-sandbox.ts`'s `readDiscoveries` used to drop one.
 *
 * `ready` keeps only `=== true`, per `isDiscovery`'s own note on it: a
 * malformed value costs the discovery its ready state, not the field's
 * presence in the output.
 */
export function normalizeDiscovery(value: Discovery): Discovery {
  const fields: Record<keyof Discovery, unknown> = {
    kind: value.kind,
    title: value.title,
    body: value.body,
    ready: value.ready === true ? true : undefined,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as unknown as Discovery;
}

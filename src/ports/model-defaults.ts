import type { TicketKind } from "./issue-tracker.ts";
import type { ModelName } from "./model-name.ts";

/**
 * The model each kind of ticket runs on when it carries no model label, the
 * same for every project.
 *
 * A kind with no entry has no default, and runs on the model the sandbox image
 * is pinned to. That is also what a machine with no model defaults document
 * looks like: every kind left out.
 *
 * The developer's to write and the loop's only to read, like the budget.
 */
export type ModelDefaults = Readonly<Partial<Record<TicketKind, ModelName>>>;

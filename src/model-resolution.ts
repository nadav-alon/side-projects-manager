import type {
  ModelDefaults,
  ModelName,
  ModelRefusal,
  Ticket,
} from "./ports/index.ts";
import { MODEL_LABEL_PREFIX, MODEL_NAME_SHAPE, ticketKind } from "./ports/index.ts";
import type { ModelRefused, ModelSource, UnusableModelLabel } from "./iteration-outcome.ts";

/** The model a ticket's run is started on, and what named it. */
export interface ResolvedModel {
  name: ModelName;
  source: ModelSource;
}

/**
 * What resolving a ticket's model against the model defaults comes to, per
 * `CONTEXT.md`'s "Model label" and "Model defaults": a model and its source,
 * no model at all — leaving the sandbox image's own pin in force — or a
 * refusal to start, for model labels no run could be started on.
 */
export type ModelResolution =
  | ({ kind: "resolved" } & ResolvedModel)
  | { kind: "none" }
  | { kind: "refused"; failure: UnusableModelLabel };

/**
 * Resolves `ticket`'s model against `defaults`. The ticket's own model label
 * wins outright — even one that names nothing usable — and the model
 * defaults are read only where the ticket names no model of its own; a kind
 * `defaults` leaves out resolves to no model, per `CONTEXT.md`'s "Model
 * defaults".
 */
export function resolveModel(
  ticket: Ticket,
  defaults: ModelDefaults,
): ModelResolution {
  const label = ticket.modelLabel;
  switch (label?.kind) {
    case "conflicting":
      return {
        kind: "refused",
        failure: {
          kind: "conflicting-model-labels",
          reason: `it carries more than one model label (${label.labels.join(", ")})`,
          labels: label.labels,
        },
      };
    case "unusable":
      return {
        kind: "refused",
        failure: {
          kind: "unusable-model-label",
          reason: `its model label names no usable model (${label.labels.join(", ")})`,
          labels: label.labels,
        },
      };
    case "named":
      return { kind: "resolved", name: label.name, source: "model label" };
    case undefined: {
      const name = defaults[ticketKind(ticket)];
      return name === undefined
        ? { kind: "none" }
        : { kind: "resolved", name, source: "model defaults" };
    }
  }
}

/**
 * A model refusal from the sandbox, as the failure its ticket is handed back
 * with.
 *
 * `source` is worked out again from `ticket` rather than threaded through
 * from `resolveModel`'s own answer: a `"model-refused"` outcome can only come
 * back from a run the sandbox was actually given a model for (`Sandbox.run`'s
 * own overload rules that out for a run given none), and the model it names
 * is always the one that run was given — so which of the ticket's own model
 * label or the model defaults that was is a fact of `ticket`, not something
 * this needs handed to it separately, and there is no "given no model" case
 * left here to guard against.
 */
export function modelRefused(ticket: Ticket, refusal: ModelRefusal): ModelRefused {
  const source: ModelSource =
    ticket.modelLabel?.kind === "named" && ticket.modelLabel.name === refusal.model
      ? "model label"
      : "model defaults";
  return {
    kind: "model-refused",
    reason: `the agent CLI refused the model ${refusal.model} (from the ${source}): ${refusal.words}`,
    refusal,
    source,
  };
}

/**
 * What is wrong with a model failure, and the imperative fix for it — the one
 * source `hand-back.ts`'s comment and `summary.ts`'s one-line digest both read
 * from, so the wording for an unusable model label or a model refusal never
 * drifts between the two.
 */
export interface ModelProblem {
  /** What is wrong, fit for the middle of a sentence. */
  problem: string;
  /** The imperative fix, fit to follow "so" or to stand on its own. */
  fix: string;
}

/** The words explaining `failure`, and how to fix it. */
export function modelProblem(
  ticket: Ticket,
  failure: UnusableModelLabel | ModelRefused,
): ModelProblem {
  switch (failure.kind) {
    case "conflicting-model-labels":
      return {
        problem: `it carries more than one model label (${labelList(failure.labels)}), and there is no telling which model it should run on`,
        fix: "keep one of them",
      };
    case "unusable-model-label":
      return {
        problem: `its model label names no model a run could be started on (${labelList(failure.labels)}): a model label is \`${MODEL_LABEL_PREFIX}<name>\`, with ${MODEL_NAME_SHAPE}`,
        fix: "fix or remove it",
      };
    case "model-refused":
      return failure.source === "model label"
        ? {
            problem: `the agent CLI refused the model \`${failure.refusal.model}\`, named by its model label, \`${MODEL_LABEL_PREFIX}${failure.refusal.model}\``,
            fix: `fix or remove its model label`,
          }
        : {
            problem: `the agent CLI refused the model \`${failure.refusal.model}\`, named by the model defaults for ${ticketKind(ticket)} tickets, in \`models.json\``,
            fix: `fix the ${ticketKind(ticket)} model in \`models.json\`, or give this ticket a model label`,
          };
  }
}

function labelList(labels: readonly string[]): string {
  return labels.map((label) => `\`${label}\``).join(", ");
}

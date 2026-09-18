import type { Checkout } from "./checkout.ts";

/**
 * What a grilling is opened to talk about: the checkout it runs in, and
 * whether the codebase in that checkout predates the manager.
 *
 * Which of the two it is stays the caller's to say rather than the session's
 * to infer. A repo the command just created holds nothing but the harness, so
 * the language it will use is still to be agreed; a repo that predates the
 * manager already has language in it, and finding that is the session's first
 * job there.
 */
export interface GrillingSubject {
  /** The project checkout the session runs in. */
  directory: Checkout;
  /** Whether the repo predates the manager rather than being created for it. */
  existing: boolean;
}

/**
 * An interactive session that turns a conversation with the developer into
 * tickets in a project's tracker, and into the vocabulary that project uses to
 * talk about itself.
 *
 * The new-project command opens a project's first one. It is not the only one
 * a project gets — later grillings are where more of its work comes from —
 * which is why this port says nothing about the project being new.
 *
 * A port rather than a spawn at the call site because everything either side
 * of it is unattended and testable, and this one step deliberately is not:
 * the developer is meant to be in this conversation.
 */
export interface Grilling {
  /** Hands the developer a session for `subject`. */
  start(subject: GrillingSubject): Promise<void>;
}

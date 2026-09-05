import { agentInstructions } from "./agent-instructions.ts";
import type {
  Grilling,
  Harness,
  RegisteredProject,
  RepoHost,
  RepoSlug,
  Store,
} from "./ports/index.ts";

/**
 * What the new-project command reaches the outside world through. Four ports,
 * the last of which is the same store the loop reads its registry from: a
 * project is started by writing the document the loop already watches.
 */
export interface NewProjectPorts {
  host: RepoHost;
  harness: Harness;
  grilling: Grilling;
  store: Store;
}

/** An idea, as the developer brought it to the command. */
export interface NewProjectRequest {
  repo: RepoSlug;
  /** One line saying what the project is. May be empty. */
  description: string;
  /**
   * Register a repo that is already on the host instead of creating one, so
   * that projects predating the manager can join. Asked for explicitly: the
   * command will not decide on the developer's behalf whether a repo it found
   * is the one they meant.
   */
  existing?: boolean;
}

export type NewProjectOutcome =
  /** The repo did not exist, so the command created it. */
  | "created"
  /** The repo was already on the host, and was registered as it stands. */
  | "existing";

/** What starting one project did. */
export interface NewProjectReport {
  repo: RepoSlug;
  outcome: NewProjectOutcome;
  /** The checkout in the managed location. */
  directory: string;
  /** What the harness put into the checkout, relative to it. */
  scaffolded: string[];
  /**
   * Whether this invocation added the project to the registry. False when it
   * was registered already, which is not an error: re-running the command on
   * a project keeps the developer's entry, paused flag and priority intact.
   */
  registered: boolean;
  /** One line, suitable for printing to a terminal. */
  message: string;
}

/**
 * One command from an idea to a project the morning loop can already see.
 *
 * Everything up to the last step is unattended: the repo, the checkout, the
 * harness, the registry entry. The last step deliberately is not. Starting a
 * project is when the developer most wants to be in the conversation, because
 * the tickets it produces are what the next month of mornings will build.
 *
 * The order matters at one place: the project is registered before the
 * grilling starts, so a session the developer walks out of still leaves a
 * registered project behind rather than an orphaned clone.
 */
export async function newProject(
  ports: NewProjectPorts,
  request: NewProjectRequest,
): Promise<NewProjectReport> {
  const { repo, description } = request;
  const existing = request.existing ?? false;
  const onHost = await ports.host.exists(repo);

  if (existing && !onHost) {
    throw new Error(
      `${repo} does not exist on GitHub. Drop --existing to create it.`,
    );
  }
  if (!existing && onHost) {
    throw new Error(
      `${repo} already exists on GitHub. Pass --existing to register it as it stands.`,
    );
  }

  if (!existing) {
    await ports.host.create(repo, description);
  }

  const directory = await ports.host.clone(repo);
  const scaffolded = await ports.harness.install(
    directory,
    agentInstructions({ repo, description }),
  );
  await ports.host.commitAndPush(directory, "Install the agent harness");

  const registered = await register(ports.store, repo);
  await ports.grilling.start(directory);

  return {
    repo,
    outcome: existing ? "existing" : "created",
    directory,
    scaffolded,
    registered,
    message: summaryLine(repo, directory, registered),
  };
}

/**
 * Appends the project to the registry, unless it is already there.
 *
 * The registry is the developer's document, so an entry that already exists is
 * left exactly as they wrote it — a project they paused stays paused, even if
 * they point the command at it again.
 */
async function register(store: Store, repo: RepoSlug): Promise<boolean> {
  const projects: RegisteredProject[] = await store.loadRegistry();
  if (projects.some((project) => project.repo === repo)) {
    return false;
  }

  await store.saveRegistry([...projects, { repo, paused: false }]);
  return true;
}

function summaryLine(
  repo: RepoSlug,
  directory: string,
  registered: boolean,
): string {
  const registry = registered
    ? "registered"
    : "already registered, so the registry is untouched";
  return `${repo} is at ${directory} and ${registry}.`;
}

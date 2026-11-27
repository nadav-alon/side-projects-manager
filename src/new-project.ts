import { agentInstructions } from "./agent-instructions.ts";
import { errorMessage } from "./error-message.ts";
import { PROJECT_LABELS } from "./project-labels.ts";
import type {
  Checkout,
  Grilling,
  GrillingSubject,
  Harness,
  Proposal,
  RegisteredProject,
  RepoHost,
  RepoSlug,
  Scaffold,
  StandardsPreset,
  Store,
  Visibility,
} from "./ports/index.ts";
import { branch, REGISTRY_FILE } from "./ports/index.ts";

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
  /**
   * The manager's own checkout, where the registry lives. A registry entry
   * left uncommitted there blocks every later pull of it, so the entry is
   * committed and pushed from this checkout.
   */
  managerHome: Checkout;
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
  /** Create the repo public rather than private. Ignored with `existing`. */
  public?: boolean;
  /**
   * The name of the manager's standards preset the project's own
   * `docs/project-standards.md` starts as. Undefined writes the stub.
   */
  standards?: StandardsPreset;
  /**
   * Give the project a GitHub Pages deploy workflow and enable Pages for it,
   * so its first push to the default branch deploys. Works with `existing`
   * too, where the workflow is proposed with the rest of the harness.
   */
  pages?: boolean;
  /**
   * The project has a UI: its registry entry carries `ui: true`, and it is
   * given a Pages deploy as with `pages`, which it implies.
   */
  ui?: boolean;
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
  directory: Checkout;
  /** What the harness put into the checkout, relative to it. */
  scaffolded: string[];
  /**
   * How the harness reached a repo that predates the manager, or undefined for
   * a repo this command created — that one is committed straight to the branch
   * the fresh clone is on, because there is nothing there to disturb.
   */
  proposal?: Proposal;
  /**
   * Whether this invocation added the project to the registry. False when it
   * was registered already, which is not an error: re-running the command on
   * a project keeps the developer's entry, paused flag and priority intact.
   */
  registered: boolean;
  /**
   * Whether the interactive session opened. False means the project is ready
   * and the conversation is not: everything before it had already happened.
   */
  grilled: boolean;
  /**
   * Why the registry entry did not reach the manager's remote, when it did
   * not. The project is registered locally and the session still ran, but the
   * loop reads the remote's registry, so the command exits non-zero on this.
   */
  registryFailure?: string;
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
  const ui = request.ui ?? false;
  const visibility: Visibility =
    (request.public ?? false) ? "public" : "private";
  // Before the host is touched: a preset that does not exist must cost nothing.
  const standards = await ports.harness.standards(request.standards);
  const onHost = await ports.host.exists(repo);

  if (existing && !onHost) {
    // GitHub answers an absent repo and a private one the credential cannot
    // see identically, so both are offered rather than the first asserted.
    throw new Error(
      `${repo} does not exist on GitHub, or your credential cannot see it. Check \`gh auth status\`, or drop --existing to create it.`,
    );
  }
  if (!existing && onHost) {
    throw new Error(
      `${repo} already exists on GitHub. Pass --existing to register it as it stands.`,
    );
  }

  if (!existing) {
    await ports.host.create(repo, description, visibility);
  }
  await ensureLabels(ports.host, repo);

  const directory = await ports.host.clone(repo);
  const scaffold = await ports.harness.install(
    directory,
    agentInstructions({ repo, description }),
    standards,
    { pages: (request.pages ?? false) || ui },
  );
  // After the install, so a workflow it just wrote counts as one the checkout has.
  await enablePagesIfDeployed(ports, repo, directory);

  // A repo created moments ago has nothing to disturb, so its harness lands
  // where the loop will read it. A repo that predates the manager has history
  // and possibly other people, so its harness is proposed and waits.
  const proposal = existing
    ? await ports.host.commitAndPropose(
        directory,
        SCAFFOLD_MESSAGE,
        proposalBody(scaffold),
        scaffold.paths,
        HARNESS_BRANCH,
      )
    : undefined;
  if (proposal === undefined) {
    await ports.host.commitAndPush(directory, SCAFFOLD_MESSAGE, scaffold.paths);
  }

  // Paused only while the harness is somewhere the loop cannot read it: a
  // project whose conventions are still in an unmerged branch would be worked
  // without them. A proposal that changed nothing means they are already there.
  const paused = proposal !== undefined && proposal.kind !== "unchanged";
  const registered = await register(ports.store, repo, paused, ui);
  // Published also when this run wrote nothing but the file is still dirty: an
  // earlier run whose push failed left its entry there, and this is the retry.
  const registryFailure =
    registered ||
    (await ports.host.hasUncommittedChanges(ports.managerHome, [REGISTRY_FILE]))
      ? await publishRegistry(ports, repo)
      : undefined;
  const grillingFailure = await startGrilling(ports.grilling, {
    directory,
    existing,
  });

  return {
    repo,
    outcome: existing ? "existing" : "created",
    directory,
    scaffolded: scaffold.paths,
    ...(proposal !== undefined && { proposal }),
    registered,
    grilled: grillingFailure === undefined,
    ...(registryFailure !== undefined && { registryFailure }),
    message: recapLine({
      repo,
      directory,
      registered,
      paused,
      proposal,
      grillingFailure,
      registryFailure,
    }),
  };
}

/**
 * Gives the repo every label the manager's docs tell people to apply. One a
 * repo already has is left as it is, so a re-run or `--existing` creates only
 * the missing ones.
 */
async function ensureLabels(host: RepoHost, repo: RepoSlug): Promise<void> {
  for (const label of PROJECT_LABELS) {
    try {
      await host.ensureLabel(repo, label);
    } catch (error) {
      throw new Error(
        `Could not create the label ${label.name} in ${repo}: ${errorMessage(error)}`,
      );
    }
  }
}

/**
 * Enables GitHub Pages, built by a workflow, on a repo whose checkout deploys
 * to it. Without it the deploy workflow fails on every push, since
 * `configure-pages` finds no site. A repo with no such workflow is left alone.
 */
async function enablePagesIfDeployed(
  ports: Pick<NewProjectPorts, "harness" | "host">,
  repo: RepoSlug,
  directory: Checkout,
): Promise<void> {
  if (!(await ports.harness.deploysToPages(directory))) {
    return;
  }
  try {
    await ports.host.enablePages(repo);
  } catch (error) {
    throw new Error(
      `Could not enable GitHub Pages in ${repo}: ${errorMessage(error)}`,
    );
  }
}

/** What the scaffold commit says, whichever way it lands. */
const SCAFFOLD_MESSAGE = "Install the agent harness";

/** Where a proposed harness waits for the developer. */
const HARNESS_BRANCH = branch("harness");

/**
 * What the pull request says the scaffold did.
 *
 * Overwritten files are named rather than left to the diff. Uniform files are
 * copied byte for byte on purpose, but a project that predates the manager
 * never agreed to that, and "this replaced something you wrote" is a fact the
 * request should state in words before anyone merges it.
 */
function proposalBody(scaffold: Scaffold): string {
  const added = scaffold.paths.filter(
    (path) => !scaffold.overwritten.includes(path),
  );
  const sections = [
    "The agent harness, so that this project can be worked unattended.",
  ];

  if (added.length > 0) {
    sections.push(["Added:", ...added.map(bullet)].join("\n"));
  }
  if (scaffold.overwritten.length > 0) {
    sections.push(
      [
        "Overwritten — this project's own copies were replaced byte for byte, so that every project reads the same conventions:",
        ...scaffold.overwritten.map(bullet),
      ].join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

function bullet(path: string): string {
  return `- \`${path}\``;
}

/**
 * Starts the grilling, and returns why it could not start rather than
 * throwing.
 *
 * By this point the project exists, is scaffolded and is registered. A session
 * that never opened — no agent CLI on the path, most likely — must not be
 * reported as a command that failed, or the developer is told nothing happened
 * when in fact everything but the conversation did.
 */
async function startGrilling(
  grilling: Grilling,
  subject: GrillingSubject,
): Promise<string | undefined> {
  try {
    await grilling.start(subject);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Appends the project to the registry, unless it is already there.
 *
 * The registry is the developer's document, so an entry that already exists is
 * left exactly as they wrote it — a project they paused stays paused, even if
 * they point the command at it again.
 */
async function register(
  store: Store,
  repo: RepoSlug,
  paused: boolean,
  ui: boolean,
): Promise<boolean> {
  const projects: RegisteredProject[] = await store.loadRegistry();
  if (projects.some((project) => project.repo === repo)) {
    return false;
  }

  await store.saveRegistry([...projects, { repo, paused, turbo: true, ...(ui && { ui: true as const }) }]);
  return true;
}

/** What the commit of a new registry entry says. */
function registryMessage(repo: RepoSlug): string {
  return `Register ${repo} as turbo`;
}

/**
 * Commits and pushes the entry just written, so the manager home is never left
 * dirty. A failure is returned, not thrown: the project is already registered
 * locally and the grilling must still start. It says where the entry stayed,
 * since a rejected push leaves it committed and a failed commit leaves it
 * uncommitted.
 */
async function publishRegistry(
  ports: NewProjectPorts,
  repo: RepoSlug,
): Promise<string | undefined> {
  try {
    await ports.host.commitAndPush(ports.managerHome, registryMessage(repo), [
      REGISTRY_FILE,
    ]);
    return undefined;
  } catch (error) {
    return `The registry entry for ${repo} is not on the manager's remote; it stays in ${ports.managerHome}/${REGISTRY_FILE}. Re-run this command to retry it (${errorMessage(error)}).`;
  }
}

/** Everything the one printed line has to account for. */
interface Recap {
  repo: RepoSlug;
  directory: Checkout;
  registered: boolean;
  paused: boolean;
  proposal: Proposal | undefined;
  grillingFailure: string | undefined;
  registryFailure: string | undefined;
}

/**
 * What happened, in one line: where the project is, whether the registry now
 * knows about it, where its harness got to, and whether the conversation
 * opened. Each clause is there because it names something the developer might
 * have to do next.
 */
function recapLine(recap: Recap): string {
  const sentences = [
    `${recap.repo} is at ${recap.directory} and ${registryClause(recap)}.`,
  ];

  const harness = harnessSentence(recap.proposal);
  if (harness !== undefined) {
    sentences.push(harness);
  }
  if (recap.registryFailure !== undefined) {
    sentences.push(recap.registryFailure);
  }
  if (recap.grillingFailure !== undefined) {
    sentences.push(
      `Its grilling could not start (${recap.grillingFailure}); start one in the checkout yourself.`,
    );
  }

  return sentences.join(" ");
}

/** What the registry now says, and why, when the command did not write it. */
function registryClause(recap: Recap): string {
  if (!recap.registered) {
    return "already registered, so the registry is untouched";
  }
  return recap.paused
    ? "registered paused, so the loop leaves it alone until its harness is merged"
    : "registered";
}

/** Where the harness got to, when it did not simply land. */
function harnessSentence(proposal: Proposal | undefined): string | undefined {
  if (proposal === undefined) {
    return undefined;
  }

  switch (proposal.kind) {
    case "unchanged":
      return "Its harness was already in place, so nothing was pushed.";
    case "proposed":
      return `Its harness is proposed in ${proposal.url}; merge that and unpause the project.`;
    case "pushed":
      return `Its harness is pushed to ${proposal.branch}, but ${proposal.failure}; open one if it isn't already open, merge it, then unpause the project.`;
  }
}

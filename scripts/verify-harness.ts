// Asserts the harness survived the sandbox image build (CONTEXT.md: Sandbox, Harness).
//
// Runs inside the built image, against that image's own `claude`. The command
// is `npm run sandbox:verify` (package.json), which is what CI invokes too —
// spelling it out a second time here is how the two drift apart.
//
// Deliberately tokenless. `claude plugin` resolves an installed plugin from
// disk with no Anthropic call in it, so this proves the skills are there
// without a subscription credential. Prompting the built image would prove the
// same thing and would need a real token, which CI has none of.

import { execFileSync } from "node:child_process";

/** What `claude plugin list --json` prints per installed plugin. */
type InstalledPlugin = {
  id?: string;
  version?: string;
  enabled?: boolean;
};

/**
 * The flag the manager hands every run its spend ceiling through
 * (CONTEXT.md: Spend ceiling). The manager cannot enforce a ceiling itself —
 * nothing out here can stop a container that is already going — so the CLI
 * accepting this flag is the whole of that enforcement. Two ways it can go,
 * and only one is loud: a flag the CLI rejects fails every run at once; a flag
 * it has renamed or dropped means no ceiling at all and nothing ever says so.
 * This is the check that makes the silent one loud.
 */
const SPEND_CEILING_FLAG = "--max-budget-usd";

/**
 * How the manager grants an unattended agent its permissions
 * (docs/specs/morning-loop.md: Sandboxing). A run is unattended, so there is
 * nobody to answer a permission question; without this flag the CLI denies
 * every tool the agent reaches for, and the run exits zero having committed
 * nothing. That is the same silent shape as a dropped spend ceiling, and it
 * has already cost one invocation eighteen tickets — so it is checked the same
 * way, against the CLI in the image rather than against the manager's belief
 * about it.
 */
const PERMISSION_FLAG = "--permission-mode";
const PERMISSION_MODE = "bypassPermissions";

/**
 * One skill the harness must expose. Naming a specific skill is what separates
 * "a plugin directory exists" from "claude can enumerate the skills in it". It
 * is a third-party name, so its absence is reported as an incomplete harness
 * or an upstream rename, never as the first alone.
 */
const REQUIRED_SKILL = "implement";

/**
 * Skill names as `claude plugin details` prints them: `Skills (25)  a, b, c`.
 * `plugin details` takes no `--json` (unlike `plugin list`), so this reads
 * display output. A format change upstream therefore has to fail as itself
 * rather than as a missing harness — hence the two separate failures below.
 */
const SKILLS_LINE = /^\s*Skills \(\d+\)\s+(.*)$/m;

/** Exits non-zero, printing what was asserted and what claude actually reported. */
function fail(message: string, evidence: string): never {
  console.error(`verify-harness: ${message}\n\n${evidence}`);
  process.exit(1);
}

/** Whatever a thrown value can offer as evidence, in the order worth printing. */
function describe(error: unknown): string {
  const thrown = error as { stderr?: string; stdout?: string; message?: string };
  return thrown?.stderr || thrown?.stdout || thrown?.message || String(error);
}

/**
 * Every failure here has to arrive through `fail`. A `claude` that is missing
 * or exits non-zero is itself one of the build regressions worth catching, and
 * an uncaught spawn error would report it as a stack trace naming neither the
 * assertion nor claude's own output.
 */
function claude(...args: string[]): string {
  try {
    return execFileSync("claude", args, { encoding: "utf8" });
  } catch (error) {
    fail(`\`claude ${args.join(" ")}\` did not run in this image`, describe(error));
  }
}

// Read off the image rather than restated here: the Dockerfile declares
// HARNESS_PLUGIN and installs exactly that, so this cannot go on asserting
// about a plugin the image stopped installing — which is the failure this
// check exists to catch, and the one a stale second copy of the id would hide.
const PLUGIN_ID = process.env["HARNESS_PLUGIN"];

if (!PLUGIN_ID) {
  fail(
    "this image declares no HARNESS_PLUGIN, so there is no harness to verify",
    "the Dockerfile sets it alongside the `claude plugin install` that reads it",
  );
}

const listed = claude("plugin", "list", "--json");

let parsed: unknown;
try {
  parsed = JSON.parse(listed);
} catch (error) {
  fail(`\`claude plugin list --json\` printed no JSON (${describe(error)})`, listed);
}

// A wrapper object where a bare array is expected would otherwise surface as a
// TypeError naming neither the assertion nor claude's output.
if (!Array.isArray(parsed)) {
  fail("`claude plugin list --json` printed no array of installed plugins", listed);
}

const installed: InstalledPlugin[] = parsed;
const harness = installed.find((plugin) => plugin.id === PLUGIN_ID);

if (!harness) {
  fail(
    `the image installs no ${PLUGIN_ID}`,
    `claude reports installed: ${installed.map((plugin) => plugin.id).join(", ") || "nothing"}`,
  );
}

// Installed is not the same as reaching a run: a disabled plugin ships none of
// its skills into a session, which is what a settings.json written after the
// install would cause. The evidence is the whole record, so it stays evidence
// whatever fields the CLI version in the image happens to emit.
if (!harness.enabled) {
  fail(
    `${PLUGIN_ID} is installed but disabled, so none of its skills reach a run`,
    `claude reports: ${JSON.stringify(harness)}`,
  );
}

const inventory = claude("plugin", "details", PLUGIN_ID);
const listing = SKILLS_LINE.exec(inventory);

if (!listing) {
  fail(
    `\`claude plugin details ${PLUGIN_ID}\` printed no skill inventory to read — a CLI output change rather than a missing harness`,
    inventory,
  );
}

const skills = (listing[1] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

if (skills.length === 0) {
  fail(`${PLUGIN_ID} is installed and enabled but enumerates no skills`, inventory);
}

if (!skills.includes(REQUIRED_SKILL)) {
  fail(
    `${PLUGIN_ID} exposes ${skills.length} skills but no ${REQUIRED_SKILL} — either the harness is incomplete or the skill was renamed upstream`,
    inventory,
  );
}

const usage = claude("--help");

if (!usage.includes(SPEND_CEILING_FLAG)) {
  fail(
    `this image's claude accepts no ${SPEND_CEILING_FLAG}, so a run in it has no spend ceiling`,
    usage,
  );
}

if (!usage.includes(PERMISSION_FLAG)) {
  fail(
    `this image's claude accepts no ${PERMISSION_FLAG}, so every run in it would be denied the tools it needs and commit nothing`,
    usage,
  );
}

// The mode by name as well as the flag: the flag surviving a rename of the
// mode would leave the manager passing a value the CLI rejects, which fails
// every run at once — loud, but only once somebody runs the loop.
if (!usage.includes(PERMISSION_MODE)) {
  fail(
    `this image's claude does not list ${PERMISSION_MODE} among the modes ${PERMISSION_FLAG} takes, so the manager passes one it will refuse`,
    usage,
  );
}

console.log(
  `${PLUGIN_ID} ${harness.version}: enabled, ${skills.length} skills, ${REQUIRED_SKILL} present, ${SPEND_CEILING_FLAG} and ${PERMISSION_FLAG} ${PERMISSION_MODE} accepted`,
);

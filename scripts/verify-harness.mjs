// Asserts the harness survived the sandbox image build (CONTEXT.md: Sandbox, Harness).
//
// Runs inside the built image, against that image's own `claude`:
//
//   docker build -t side-projects-sandbox .
//   docker run --rm -v "$(pwd)/scripts:/scripts:ro" \
//     --entrypoint node side-projects-sandbox /scripts/verify-harness.mjs
//
// Deliberately tokenless. `claude plugin` resolves an installed plugin from
// disk with no Anthropic call in it, so this proves the skills are there
// without a subscription credential. Prompting the built image would prove the
// same thing and would need a real token, which CI has none of.

import { execFileSync } from "node:child_process";

/** The plugin the harness ships as, as the Dockerfile installs it. */
const PLUGIN_ID = "mattpocock-skills@claude-plugins-official";

/**
 * One skill the harness must expose. Naming a specific skill is what separates
 * "a plugin directory exists" from "claude can enumerate the skills in it".
 */
const REQUIRED_SKILL = "implement";

/** Skill names as `claude plugin details` prints them: `Skills (25)  a, b, c`. */
const SKILLS_LINE = /^\s*Skills \(\d+\)\s+(.*)$/m;

/** Exits non-zero, printing what was asserted and what claude actually reported. */
function fail(message, evidence) {
  console.error(`verify-harness: ${message}\n\n${evidence}`);
  process.exit(1);
}

/**
 * Every failure here has to arrive through `fail`. A `claude` that is missing
 * or exits non-zero is itself one of the build regressions worth catching, and
 * an uncaught spawn error would report it as a stack trace naming neither the
 * assertion nor claude's own output.
 */
function claude(...args) {
  try {
    return execFileSync("claude", args, { encoding: "utf8" });
  } catch (error) {
    fail(
      `\`claude ${args.join(" ")}\` did not run in this image`,
      error.stderr || error.stdout || error.message,
    );
  }
}

const listed = claude("plugin", "list", "--json");

let installed;
try {
  installed = JSON.parse(listed);
} catch (error) {
  fail(`\`claude plugin list --json\` printed no JSON (${error.message})`, listed);
}

const harness = installed.find((plugin) => plugin.id === PLUGIN_ID);

if (!harness) {
  fail(
    `the image installs no ${PLUGIN_ID}`,
    `claude reports installed: ${installed.map((plugin) => plugin.id).join(", ") || "nothing"}`,
  );
}

// Installed is not the same as reaching a run: a disabled plugin ships none of
// its skills into a session, which is what a settings.json written after the
// install would cause.
if (!harness.enabled) {
  fail(
    `${PLUGIN_ID} is installed but disabled, so none of its skills reach a run`,
    `installed at ${harness.installPath}`,
  );
}

const inventory = claude("plugin", "details", PLUGIN_ID);
const skills = SKILLS_LINE.exec(inventory)?.[1].split(",").map((name) => name.trim()) ?? [];

if (!skills.includes(REQUIRED_SKILL)) {
  fail(`${PLUGIN_ID} exposes no ${REQUIRED_SKILL} skill`, inventory);
}

console.log(
  `${PLUGIN_ID} ${harness.version}: enabled, ${skills.length} skills, ${REQUIRED_SKILL} present`,
);

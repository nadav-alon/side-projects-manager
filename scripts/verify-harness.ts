// Asserts the harness survived the sandbox image build (CONTEXT.md: Sandbox, Harness),
// and that the image's browser still screenshots a page. The browser is not part
// of the Harness; it is checked here because this is the one script that runs
// inside the built image.
//
// Runs inside the built image, against that image's own `claude`. The command
// is `npm run sandbox:verify` (package.json), which is what CI invokes too —
// spelling it out a second time here is how the two drift apart.
//
// Deliberately tokenless. `claude plugin` resolves an installed plugin from
// disk with no Anthropic call in it, so this proves the skills are there
// without a subscription credential. Prompting the built image would prove the
// same thing and would need a real token, which CI has none of.

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// `sandbox:verify` (package.json) mounts these files from `src/` alongside
// `scripts/` for exactly these imports.
import { errorMessage } from "../src/error-message.ts";
import { cliSettings } from "../src/adapters/manager-settings.ts";
import { branch } from "../src/ports/branch.ts";

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
 * The skill for a run that applies a pull request's review, not part of the
 * harness plugin above — the Dockerfile copies the manager repo's own
 * `.claude/skills/apply-pr-review/SKILL.md` into the CLI's personal-skill
 * directory so it is found whichever project a run's clone happens to be.
 * `disable-model-invocation: true` on the skill means a run invokes it
 * explicitly (`/apply-pr-review <url>`) rather than the model discovering it,
 * so this only has to prove the file is there, not that `claude` enumerates
 * it — there is no CLI command that lists personal skills the way `plugin
 * details` lists a plugin's.
 */
const APPLY_REVIEW_SKILL = "apply-pr-review";

/**
 * The skill for a run that rebases a pull request's branch onto its base, copied
 * into the same personal-skill directory for the same reason as
 * APPLY_REVIEW_SKILL above: `disable-model-invocation: true` means a run invokes
 * it explicitly (`/rebase-pr <pull request url>`), so this only has to prove the
 * file is there.
 */
const REBASE_SKILL = "rebase-pr";

/**
 * The skill for a run that reviews how a project's app feels in a browser,
 * copied into the same personal-skill directory for the same reason as
 * APPLY_REVIEW_SKILL above (`/ux-review <ticket>`).
 */
const UX_REVIEW_SKILL = "ux-review";

/** Every skill copied into the personal-skill directory rather than shipped by a plugin. */
const PERSONAL_SKILLS = [APPLY_REVIEW_SKILL, REBASE_SKILL, UX_REVIEW_SKILL];

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
  const thrown = error as { stderr?: string; stdout?: string };
  return thrown?.stderr || thrown?.stdout || errorMessage(error);
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

// The uid this check runs as. Two invocations matter and the script is the same
// either way: `npm run sandbox:verify` passes no `--user`, so the uid is the
// image's own declared default, which is what a bare `docker run` gets;
// `npm run sandbox:verify:pinned` passes one the image has never heard of,
// which is what the manager pins on a host whose developer is not uid 1000
// (`dockerCommand`).
const UID = process.getuid?.();

// Root is the one uid an unattended run cannot happen under: the CLI refuses
// the permission mode below under root or sudo, and the container exits with a
// plain-text refusal rather than the JSON envelope the manager reads — which
// arrives downstream as an agent that spent nothing and gave up. Checked here
// rather than trusted to the Dockerfile, because the harness lives in the
// non-root user's home and moving one without the other is how the image ends
// up with either no user or no skills.
if (UID === 0) {
  fail(
    "this image runs as root by default, so the CLI will refuse the permission mode every unattended run needs",
    "the Dockerfile's USER line is what declares the default user",
  );
}

/**
 * Whatever kept this uid from creating something in `directory`, or undefined
 * when nothing did. Probed rather than read off the mode bits: what a uid can
 * do there depends on owner, group and mode together, and the pinned uid owns
 * none of it.
 */
function unwritable(directory: string): string | undefined {
  try {
    rmSync(mkdtempSync(path.join(directory, ".verify-harness-")), {
      recursive: true,
    });
    return undefined;
  } catch (error) {
    return describe(error);
  }
}

// The CLI keeps its own state beside the harness — which plugins are enabled,
// what a session said — so a home this uid cannot write to is not a working
// image even when every read below passes. And every read below does pass: the
// harness is world-readable at its default 0755 whether the Dockerfile's
// `chmod -R a+rwX "$HOME"` ran or not, so reading it proves nothing about a
// foreign uid. Writing is the half that does, which is why the pinned
// invocation exists.
const HOME = homedir();

for (const directory of [HOME, path.join(HOME, ".claude")]) {
  const refusal = unwritable(directory);
  if (refusal) {
    fail(
      `uid ${UID} cannot write to ${directory}, so the CLI has nowhere to keep the state a run needs`,
      refusal,
    );
  }
}

// Checked by existence rather than through `claude`, for the reason each of
// PERSONAL_SKILLS' own doc comments gives.
for (const skill of PERSONAL_SKILLS) {
  const skillPath = path.join(HOME, ".claude", "skills", skill, "SKILL.md");

  if (!existsSync(skillPath)) {
    fail(
      `${skillPath} is missing, so a run has no ${skill} skill to invoke`,
      `the Dockerfile's COPY of .claude/skills/${skill}/SKILL.md is what puts it there`,
    );
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

/**
 * Env vars the Dockerfile pins for the mid-stream byte watchdog that ends a
 * run whose API response goes quiet (#495), each with what leaving it
 * unpinned would cost. Checked here the same way the plugin and skills above
 * are: against the running container's own environment, not against the
 * Dockerfile text, since a rebuild that drops an `ENV` line would leave the
 * Dockerfile saying one thing and a run doing another.
 */
const PINNED_ENV: { variable: string; pinned: string; consequence: string }[] = [
  {
    variable: "CLAUDE_ENABLE_BYTE_WATCHDOG",
    pinned: "1",
    consequence:
      "a stalled response is left to the remote flag `tengu_stream_watchdog_default_on` rather than ending itself",
  },
  {
    // The CLI's own first-party default (180000ms), so pinning it changes a
    // run's behaviour only where the remote flag above would have moved it.
    variable: "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
    pinned: "180000",
    consequence: "a stalled run's idle window is not what the Dockerfile pins",
  },
];

for (const { variable, pinned, consequence } of PINNED_ENV) {
  if (process.env[variable] !== pinned) {
    fail(
      `this container's ${variable} is ${JSON.stringify(process.env[variable])}, not ${JSON.stringify(pinned)}, so ${consequence}`,
      `the Dockerfile's \`ENV ${variable}=${pinned}\` is what pins it`,
    );
  }
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

/**
 * The manager's own deny rules are only worth what the CLI in the image does
 * with them: a CLI that stopped honouring `permissions.deny` from `--settings`
 * would leave every run free to merge, and nothing would say so. So a real
 * call is made with the settings a plain run gets, and `gh pr merge` must come
 * back among the envelope's `permission_denials` (a command that merely
 * contains it counts, as `cd x && gh pr merge 1` would). A model that declines to
 * make the call fails the check as such, not as a CLI that ignored the rule. Needs a model to ask for the
 * call, hence a credential: without `CLAUDE_CODE_OAUTH_TOKEN` the check says it
 * was skipped rather than passing.
 */
function assertMergeDenied(): void {
  if (!process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    console.log("verify-harness: skipped the deny-rule check, there is no CLAUDE_CODE_OAUTH_TOKEN to ask a model with");
    return;
  }

  const output = claude(
    "--print",
    "This is a permission test. Run the shell command `gh pr merge 1` once and report what happened.",
    "--output-format",
    "json",
    "--permission-mode",
    PERMISSION_MODE,
    "--settings",
    cliSettings("run", branch("master")),
    "--max-budget-usd",
    "0.25",
  );

  let envelope: {
    num_turns?: number;
    permission_denials?: { tool_name?: string; tool_input?: { command?: string } }[];
  };
  try {
    envelope = JSON.parse(output);
  } catch (error) {
    fail(`the deny-rule check's claude printed no JSON envelope (${describe(error)})`, output);
  }

  const denied = (envelope.permission_denials ?? []).some(
    (denial) => denial.tool_name === "Bash" && denial.tool_input?.command?.includes("gh pr merge"),
  );
  if (!denied && (envelope.num_turns ?? 0) < 2) {
    // A call that is made and refused costs a turn to answer; a run of one turn
    // is a model that declined to make it, which says nothing of the CLI.
    fail("the model never attempted `gh pr merge`, so the deny rule was not exercised", output);
  }
  if (!denied) {
    fail(
      "a `gh pr merge` call was not denied by the manager's own settings, so a run in this image could merge a pull request",
      output,
    );
  }
}

assertMergeDenied();

/**
 * How long the browser check may take end to end. Starting Chromium cold in a
 * container is slow, but a hang must still end as a failure naming this check.
 */
const BROWSER_TIMEOUT_MS = 90_000;

/** The first bytes of every PNG file. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** The same signature as it begins a base64-encoded PNG, as an MCP reply inlines one. */
const PNG_BASE64_PREFIX = "iVBORw0KGgo";

/** The title of the page the check serves, which the navigation reply must name. */
const BROWSER_PAGE_TITLE = "verify";

/** What an MCP reply looks like to this check: either kind of failure, or a result. */
interface McpReply {
  id?: number;
  error?: unknown;
  result?: { isError?: boolean };
}

/** The reply's failure, if any: a JSON-RPC error, or a tool call that came back `isError`. */
function replyFailure(reply: McpReply): string | undefined {
  return reply.error || reply.result?.isError ? JSON.stringify(reply) : undefined;
}

/**
 * Drives `@playwright/mcp` the way a run would — headless, over stdio — to
 * open a page and screenshot it, and returns the screenshot's MCP
 * response. No `--browser`: the image's own default, PLAYWRIGHT_MCP_BROWSER, is
 * what is under test. `--no-sandbox` because Chromium's own sandbox needs user
 * namespaces that a container's default seccomp profile withholds; the
 * container is the sandbox.
 */
function screenshotPage(pageUrl: string, outputDir: string): Promise<string> {
  const server = spawn(
    "playwright-mcp",
    ["--headless", "--isolated", "--no-sandbox", "--output-dir", outputDir],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "verify-harness", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "browser_navigate",
        arguments: { url: pageUrl },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_take_screenshot", arguments: { type: "png" } },
    },
  ];

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const evidence = () => `${stderr}\n${stdout}`.trim();
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error(`no screenshot within ${BROWSER_TIMEOUT_MS}ms\n${evidence()}`));
    }, BROWSER_TIMEOUT_MS);

    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    server.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const replies = stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line): McpReply | undefined => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })
        .filter((message): message is McpReply => message !== undefined);
      const navigation = replies.find((message) => message.id === 2);
      const screenshot = replies.find((message) => message.id === 3);
      if (navigation && screenshot) {
        clearTimeout(timer);
        server.kill();
        const navigationFailure = replyFailure(navigation);
        const screenshotFailure = replyFailure(screenshot);
        if (navigationFailure) {
          reject(new Error(`could not open the page: ${navigationFailure}`));
        } else if (!JSON.stringify(navigation).includes(BROWSER_PAGE_TITLE)) {
          reject(new Error(`the page did not load, its title is not in: ${JSON.stringify(navigation)}`));
        } else if (screenshotFailure) {
          reject(new Error(`could not screenshot the page: ${screenshotFailure}`));
        } else {
          resolve(JSON.stringify(screenshot));
        }
      }
    });

    for (const request of requests) {
      server.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}

// What a run gets when it enables the browser: the server starts headless as
// this uid and produces a real image of a page served over http, as `ux-review`
// will point it at one (the server refuses `file://` by default). The screenshot is asserted by
// its bytes — a PNG signature on disk or in the reply — rather than by the
// server merely answering, since a server with no Chromium answers fine and
// only fails at the screenshot.
const browserDir = mkdtempSync(path.join(tmpdir(), "verify-browser-"));
const pageServer = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>${BROWSER_PAGE_TITLE}</title><h1>verify-harness</h1>`);
});
await new Promise<void>((listening) => pageServer.listen(0, "127.0.0.1", listening));

try {
  const address = pageServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("the page server has no port");
  }
  const reply = await screenshotPage(`http://127.0.0.1:${address.port}/`, browserDir);
  const written = readdirSync(browserDir).filter((name) => name.endsWith(".png"));
  const inline = reply.includes(PNG_BASE64_PREFIX);
  const onDisk = written.some((name) =>
    readFileSync(path.join(browserDir, name))
      .subarray(0, PNG_SIGNATURE.length)
      .equals(PNG_SIGNATURE),
  );
  if (!inline && !onDisk) {
    fail("`playwright-mcp` answered but produced no PNG screenshot", reply);
  }
} catch (error) {
  fail(
    `\`playwright-mcp\` could not screenshot a local page headless as uid ${UID}, so a run that enables the browser has none`,
    describe(error),
  );
} finally {
  pageServer.close();
  rmSync(browserDir, { recursive: true, force: true });
}

const personalSkillsPresent = PERSONAL_SKILLS.map((skill) => `${skill} present`).join(", ");
const pinnedEnvPresent = PINNED_ENV.map(({ variable, pinned }) => `${variable}=${pinned}`).join(
  " and ",
);

console.log(
  `${PLUGIN_ID} ${harness.version}: enabled, ${skills.length} skills, ${REQUIRED_SKILL} present, ${personalSkillsPresent}, ${SPEND_CEILING_FLAG} and ${PERMISSION_FLAG} ${PERMISSION_MODE} accepted, playwright-mcp screenshot a local page, ${pinnedEnvPresent} pinned, running as uid ${UID} with ${HOME} writable`,
);

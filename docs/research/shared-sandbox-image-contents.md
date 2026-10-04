# What should the shared sandbox image carry, now that a project can layer its own?

[ADR 0014](../adr/0014-a-project-may-layer-its-own-image-on-the-shared-one.md) (#1213) lets a project
declare `.sandbox/Dockerfile` on top of `side-projects-sandbox:latest`. Until then the shared image
had to carry everything any project's runs might need. This audits what it carries, who uses each
piece, and what moving a piece into a project's image would cost. It decides nothing: the
recommendations at the end are recommendations, and what moves stays the developer's call.

Evidence is read from this repo at `7a863f23454c0a6079b58b8cbda6462b6434ff7f`, and from
`nadav-alon/home-catalogue` at `41519209aad1e720957829b029c76abcc2f2f373` and
`nadav-alon/data-platform` at `ecde5b0a4ce7d0f44a8a0e762c3f5c3ec9c65c9c` through `gh api` (read
only; nothing changed in either), so a line reference stays correct. Neither project has a `.sandbox/` today (`gh api …/contents/.sandbox` is a 404 for both), so
both run in the shared image as it stands. Nothing here was built or run.

## What the shared image carries

Everything below is in the [`Dockerfile`](../../Dockerfile).

| Tool | Who uses it | Evidence |
| --- | --- | --- |
| `node:22-slim` base, with the `npm`, `npx` and `corepack` it ships | Every run | The CLI and the Playwright MCP are npm packages, and every `npm ci` or `npm test` a run makes needs `npm`; every project's `engines` is `node >=22.18` (`package.json` of both). |
| `git` | Every run | Every run ends in commits; the plugin install clones the marketplace with it; the skills shell out to it (`docs/agents/issue-tracker.md`). |
| `gh` | Every run | The issue tracker is driven only through `gh` (`docs/agents/issue-tracker.md`); apply-review and rebase runs push and comment through it. |
| `curl`, `ca-certificates` | The image build (and HTTPS for git/gh/npm at run time) | `curl` fetches the `gh` apt key at build; `ca-certificates` is what lets `git`, `gh` and `npm` verify TLS in a run. No run kind or skill calls `curl` (grep of `.claude/`, `docs/agents/`, `src/`, `scripts/`). |
| `jq` | The manager's own `npm test`; nothing else found | `.github/workflows/scripts/rebase.sh` calls `jq` (12 uses), and `src/workflows/rebase.test.ts` runs it — here, in the sandbox, as the Dockerfile says. `rebase.sh` is a uniform file, so both projects have a copy, but neither project has a test that runs it (no `*.test` over `.github/workflows/scripts` in either tree), and in a project it runs on a GitHub Actions runner, which has its own `jq`. `docs/agents/issue-tracker.md` mentions filtering with `jq`, but the `gh --jq` flag it also uses is built into `gh` and needs no binary. |
| Temurin 21 JRE (`JAVA_HOME`, `PATH`) | `nadav-alon/home-catalogue` and `nadav-alon/data-platform` | Both `package.json`s have `test:rules`, which runs `firebase emulators:exec` (firebase-tools is a devDependency of both); both CI workflows add `actions/setup-java` 21 for that job. `home-catalogue` also needs it for `npm run ux`, whose `AGENTS.md` says "Java must be on the PATH" (it starts the emulators from `data-platform/local`). `data-platform/docs/local-kit.md` says the same of `data-platform/local`. The manager and `ltlf-external-knowledge` (C++) do not use it. |
| `@anthropic-ai/claude-code` | Every run | It is the `ENTRYPOINT`; the manager parses its JSON output. |
| Harness plugin `mattpocock-skills@claude-plugins-official`, `settings.json` model pin | Every run | The skills a run is told to follow; installed as `node` so any uid can read it (Dockerfile comments; `scripts/verify-harness.ts`). |
| Personal skills `apply-pr-review`, `rebase-pr`, `ux-review` | One run kind each | Copied in so they are found whichever project is mounted. `apply-pr-review` and `rebase-pr` serve apply-review and rebase runs; `ux-review` serves ux-review runs. |
| `@playwright/mcp` + Chromium + its system libraries, `PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_MCP_BROWSER` | One run kind: ux review; one project today: `home-catalogue` | `src/adapters/container-sandbox.ts` starts `playwright-mcp` (`PLAYWRIGHT_MCP_CONFIG`) only for `uxReview`. `.claude/skills/ux-review/SKILL.md` stops at step 2 for a project with no `ux` script. `home-catalogue` has `"ux": "node scripts/ux.ts"`; `data-platform` has none, so a ux review there hands back having done nothing. |
| Git identity, `safe.directory`, `HOME`, non-root `node`, byte-watchdog env | Every run | Needed for commits, for the bind-mounted clone, and for the CLI to run unattended. |

## What a move would cost

ADR 0014: a project image is `FROM side-projects-sandbox:latest`, built by the manager when its
digest of the Dockerfile, its build context and the shared image's id changes. Two consequences
apply to every move below.

- **Rebuilds.** A project image rebuilds when the project's `.sandbox/` changes and whenever the
  shared image is rebuilt (the shared image's id is in the digest). Shrinking the shared image does
  not reduce how often that happens. It does make the shared rebuild itself smaller and faster, and
  it moves the cost of the moved layer onto each project's rebuild instead. Layers added on top of
  an unchanged base are cached, so a project rebuild after a shared rebuild re-runs all of the
  project's layers, including a moved JRE or Chromium.
- **Declared twice.** A tool two projects need is written in two `.sandbox/Dockerfile`s, which can
  drift (JRE version, Playwright version). Nothing shares a fragment between them.
- **Failure mode.** A project with no `.sandbox/` that needs the moved tool fails mid-run (a
  blocking prerequisite discovery), and a failed project build refuses every run kind for that
  project. Moving a tool therefore adds a failure path the shared image does not have.

Per tool not needed by every run:

- **`jq`** — Used only by the manager's own `npm test`, so the manager is the only project that
  would declare it. The manager has no `.sandbox/` today (and its `rebase.sh` test runs wherever its
  CI runs, not only in the sandbox). The manager's own sandbox runs would rebuild its project image
  whenever the shared one does. Cost: a manager `.sandbox/Dockerfile` of one `apt-get install jq`
  and a project image where there was none. The saving is small.
- **`curl`** — Used only at build time. Removing it from the final layers, or purging it after the
  `gh` key fetch, is a change inside the shared image, not a move: no project would declare it.
- **JRE** — Declared by `home-catalogue` and `data-platform` (2 projects, twice). Both rebuild when
  the shared image does. The ADR's own example of why a project needs its own toolchain; the
  Dockerfile's comment names the Firebase emulators as its sole reason. The base image's Debian
  packages only Java 17, so each project's Dockerfile would repeat the `COPY --from=eclipse-temurin:21-jre`
  step or an equivalent. A project the JRE leaves (the manager, `ltlf-external-knowledge`, any
  future project) stops carrying a JRE it never runs. The risk is a Firebase project that adds
  `test:rules` without a `.sandbox/` and discovers the gap only mid-run.
- **Playwright + Chromium** — Declared by `home-catalogue` alone today (1 project); `data-platform`
  would not, having no `ux` script. A project image carrying it means ux-review runs for
  `home-catalogue` only. Moving it also requires the manager to stop assuming the browser is
  there: `PLAYWRIGHT_MCP_CONFIG` names `playwright-mcp` unconditionally for `uxReview`,
  `scripts/verify-harness.ts` screenshots a page with it as part of `npm run sandbox:verify` (which
  CI runs), and `.claude/skills/ux-review/SKILL.md` assumes it. So the move is more than a Dockerfile
  edit: the verify step would have to run against a project image or drop the check, and a ux review
  on a project that has a `ux` script but no browser declared would fail mid-run.
- **`ux-review`, `apply-pr-review`, `rebase-pr` skills** — A few kB each, and tied to run kinds
  that the manager starts in any project. They cannot sensibly move to a project (a project's clone
  must not carry a skill about the manager's workflow, per the Dockerfile's comment).

## Are Playwright and Chromium the harness's or a project's?

Split, by the two things the word could mean:

- **The mechanism is the harness's.** The manager decides when a browser exists (`playwrightMcp`
  only for `uxReview`), writes the MCP config, ships the `ux-review` skill, and verifies the browser
  at build time. None of that is in any project's repo, and `scripts/verify-harness.ts` says the
  browser "is not part of the Harness" in the glossary sense but is checked there because it is the
  one script that runs in the built image.
- **The need is a project's.** A ux review only does anything on a project with a `ux` script, and
  only `home-catalogue` has one. `data-platform` and the manager never start the browser; for them
  it is dead weight on disk, as the Dockerfile's own comment says.

So the browser is a project's *need* served by the harness's *mechanism*. Which side the binary lives
on is the trade-off in the cost section: it is shared today because the wiring is, and moving it
means the wiring has to learn that the browser may be absent.

## Recommendation

The developer decides; these are one reader's recommendations.

| Tool | Recommendation | Why |
| --- | --- | --- |
| `node:22-slim`, `git`, `gh`, `ca-certificates`, Claude CLI, harness plugin, settings, git identity, non-root user, watchdog env | **Keep** in the shared image | Every run needs them; no project could supply them without the manager's wiring. |
| Personal skills `apply-pr-review`, `rebase-pr`, `ux-review` | **Keep** | They exist because a project's clone cannot carry them. |
| `jq` | **Keep for now; revisit** | Only the manager's own tests use it, but moving it creates a `.sandbox/` for the manager. Not worth a new failure path. |
| `curl` | **Trim in place** (purge after the key fetch) | Not a move; no project declares it, and no run uses it. |
| Temurin 21 JRE | **Move** to `home-catalogue` and `data-platform` `.sandbox/Dockerfile`s | The clearest per-project need: exactly two projects, both with the same `test:rules`, and a JRE on disk for every other run. Accept the duplicate declaration; keep the version in step by hand, or have the second project copy the first. Do it only after both projects' `.sandbox/` exist and one has built, since a missing JRE fails `test:rules` mid-run. |
| Playwright + Chromium | **Keep for now** | One project uses it, but moving it takes changes in the manager (config, verify step), which is a separate ticket's worth of work. Revisit if a second ux-less project makes the disk cost matter, or if the browser's version needs to differ per project. |

## What this does not cover

- `nadav-alon/ltlf-external-knowledge` (paused C++ project) was only checked for a Java or browser
  need through its `AGENTS.md`; nothing suggests either.
- Image size was not measured, so no saving above is quantified;
  the sandbox has no docker.

# Is swapping `containerSandbox`'s adapter for sandcastle worth it?

`containerSandbox` (`src/adapters/container-sandbox.ts`) takes a `Container` function — default
`dockerContainer` — that clones the project checkout, runs the manager's own image with `docker run`,
and reports back branch, commits, output and token usage. The spec originally said this work was
delegated to sandcastle; [ADR 0001](../adr/0001-manager-owns-its-container-adapter.md) records owning
it instead as a decision revisitable once this research (#29) lands. This answers whether it is worth
reversing.

Every finding below cites a primary source: sandcastle's own source, docs, ADRs or release metadata,
pinned to `v0.12.0` (its `package.json` version at the time of writing) so a line reference stays
correct even if the project moves on. Nothing here was run — no sandcastle install, no live agent —
per the ticket's own scope.

Two words below are sandcastle's, not [`CONTEXT.md`](../../CONTEXT.md)'s. **Worktree** means a real
`git worktree`, the mechanism sandcastle mounts — not our throwaway clone, which the glossary says is
no worktree. **Provider** means sandcastle's own backend abstraction (`docker()`, `claudeCode()`,
`AgentProvider`) — roughly what the glossary calls an adapter, and unrelated to the provider whose
limit refuses runs.

## What sandcastle is

`@ai-hero/sandcastle` is a TypeScript library — "Orchestrate sandboxed coding agents in TypeScript
with `sandcastle.run()`" — published to npm, MIT-licensed, source at
[github.com/mattpocock/sandcastle](https://github.com/mattpocock/sandcastle). It is obtained with
`npm install --save-dev @ai-hero/sandcastle`; there is no paywall and no metered cost to the library
itself.

- **Footprint.** Its only hard runtime dependency is `@clack/prompts` (CLI prompt UI). `@daytona/sdk`
  and `@vercel/sandbox` are optional peer dependencies needed only by those two cloud providers —
  the Docker and Podman providers this research is about need nothing beyond the `docker`/`podman`
  CLI already on `PATH`.
  ([`package.json`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/package.json))
- **Maintenance.** Effectively a single-maintainer project: `mattpocock` holds 1,025 of roughly 1,080
  commits; the next human contributor holds 4. It shipped 30 releases (`v0.4.1`→`v0.12.0`) in about
  three months, then nothing — the last commit and last release (`v0.12.0`) both land on
  2026‑06‑29, so as of this writing (2026‑09‑13) the repository has been quiet for about two and a
  half months. It has real traction for its age (created 2026‑03‑17): 7,974 stars, 857 forks, 169
  open issues.
  ([repo metadata](https://api.github.com/repos/mattpocock/sandcastle),
  [releases](https://github.com/mattpocock/sandcastle/releases),
  [contributors](https://api.github.com/repos/mattpocock/sandcastle/contributors))
  The triage note on #29 says v0.12.0 published 2026‑09‑14; the release API disagrees (it
  shipped 2026‑06‑29) — the identity and license check out, but re-verify currency before relying on
  the "actively maintained" framing again.
- **Providers.** It is provider-agnostic: built-in Docker, Podman, Vercel (Firecracker microVMs) and
  Daytona sandbox providers, plus a `noSandbox()` escape hatch that runs the agent directly on the
  host. Only Docker is evaluated below, since it is what our adapter already uses.
  ([`src/sandboxes/`](https://github.com/mattpocock/sandcastle/tree/v0.12.0/src/sandboxes),
  [ADR 0015](https://github.com/mattpocock/sandcastle/blob/v0.12.0/docs/adr/0015-no-sandbox-in-run-and-create-sandbox.md))

## Findings, one per question

### 1. Caller-supplied image (harness baked in at build time, #6; reinstalling per run rejected)

**Answered: yes.** `docker({ imageName })` accepts a prebuilt image name outright; nothing about
sandcastle's `docker()` provider builds or installs anything at run time unless the caller also calls
its separate `buildImage`/`sandcastle docker build-image` step. A pre-flight check
(`checkImageUid`) inspects the named image's baked-in `USER` and refuses to start if its UID doesn't
match the UID the run wants — it errors with a clear remediation, it never rebuilds behind the
caller's back.
([`src/sandboxes/docker.ts:37-46,132-177,398-439`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/docker.ts#L37-L46))

Pointing `docker({ imageName: "side-projects-sandbox:latest" })` at the existing image from #6 would
work as-is.

### 2. How it handles the checkout — worktree, and the dot-git-pointer problem

**Answered: it mounts a worktree, and it solves the exact problem that made our adapter clone
instead.** For its `merge-to-head` and `branch` branch strategies, sandcastle creates a real
`git worktree` under `.sandcastle/worktrees/` and bind-mounts *that* directory into the container —
not a clone.
([`src/WorktreeManager.ts:277-428`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/WorktreeManager.ts#L277-L428))

The dot-git-pointer problem is handled explicitly. `resolveGitMounts` detects that the worktree's
`.git` is a file (not a directory), reads its `gitdir: <path>` pointer, and returns **two** mount
entries: the worktree's own `.git` file, and the parent repository's real `.git` directory — mounted
at the *same absolute host path* inside the container (`sandboxPath === hostPath`). Because the
pointer itself is an absolute path and Linux gets no path remapping, the pointer resolves inside the
container without rewriting anything.
([`src/SandboxFactory.ts:259-288`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/SandboxFactory.ts#L259-L288))

This is exactly the fix and sandcastle's own ADR says so directly, in the course of explaining why
*Windows* needs more work: "On Linux, this is fine — the parent `.git` dir is mounted at its original
host path, and the `gitdir:` pointer resolves." Windows needs a rewrite (`patchGitMountsForWindows`,
mounting the parent `.git` at a deterministic `/.sandcastle-parent-git` and overlaying a corrected
`.git` file) only because Windows host paths aren't valid inside a Linux container.
([ADR 0006](https://github.com/mattpocock/sandcastle/blob/v0.12.0/docs/adr/0006-git-worktree-mounts-on-windows.md),
[`src/mountUtils.ts:27-30,196-326`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/mountUtils.ts#L27-L30))

**Caveat worth naming.** Solving the pointer means bind-mounting the *real* repository's `.git`
directory — objects, refs, everything — into a container running an unattended agent under
`--dangerously-skip-permissions`. Our clone gives the agent no path back to the checkout's object
store at all (`container-sandbox.ts:142-146`, "the adapter clones... A clone carries its objects with
it and needs nothing else mounted"). Sandcastle's worktree shares the object database with the
developer's checkout by design — not a bug, but a different, larger blast radius than "the agent's
whole world is a throwaway clone of one project."

### 3. Isolation beyond `docker run --rm` with one mount

**Answered: comparable, with a couple of extra opt-in dials, no default restriction.** The Docker
provider supports optional `--network` (attach named network(s); the default is Docker's ordinary
bridge — unrestricted egress, same as ours), `--cpus` (fractional CPU ceiling, opt-in, unconstrained
by default), `--group-add` and `--device` (for opt-in host socket/device access, e.g.
Docker-outside-of-Docker), and an SELinux volume label. None of these are a *restriction* enabled by
default — no built-in "no network" mode, no memory ceiling of any kind, and `--cpus` is the only
resource ceiling and it is off unless the caller sets it.
([`src/sandboxes/docker.ts:37-124`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/docker.ts#L37-L124),
[`src/DockerLifecycle.ts:75-171`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/DockerLifecycle.ts#L75-L171))

### 4. Non-root execution, uid pin (#27)

**Answered: the mechanism exists; the root refusal does not.** `docker()` defaults
`containerUid`/`containerGid` to `process.getuid()`/`process.getgid()`, exactly like our
`hostUser()`, and a pre-flight check refuses to start if the image's baked-in UID doesn't match.
([`src/sandboxes/docker.ts:173-177,398-439`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/docker.ts#L173-L177),
[ADR 0014](https://github.com/mattpocock/sandcastle/blob/v0.12.0/docs/adr/0014-docker-uid-alignment-via-build-arg.md))

But nothing special-cases uid 0. Our `hostUser()` throws `AgentNeverRan` naming root as the cause
before docker ever runs (`container-sandbox.ts:710-722`); sandcastle would simply pass `--user 0:0`
and let whatever happens next — the Claude CLI itself refusing `--dangerously-skip-permissions` under
root — surface as a generic non-zero exit, indistinguishable from a ticket the agent gave up on (see
finding 9). The underlying constraint is shared; the diagnostic that names it is not.

### 5. Round-trip result — branch, commits, output, token usage

**Answered: survives on success, is discarded by default on failure.**

On success, `run()`'s `RunResult` carries `commits` (`{ sha }[]`), `branch`, `stdout`, and
per-iteration `usage` with exactly the four fields our own `totalTokens()` sums —
`inputTokens`/`cacheCreationInputTokens`/`cacheReadInputTokens`/`outputTokens`, read straight off the
Claude Code session JSONL.
([`src/run.ts:449-456`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/run.ts#L449-L456),
[`src/AgentProvider.ts:1237-1258`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L1237-L1258);
compare [`container-sandbox.ts:837-852`](../../src/adapters/container-sandbox.ts#L837-L852))

On failure, it does not. As soon as `sandbox.exec()` returns a non-zero exit code, the whole
iteration effect fails with `AgentError`, carrying only a message (stderr, or a fallback) and,
sometimes, a `preservedWorktreePath` — the token usage accumulated mid-stream is a local variable
that is never returned, and `run()` re-throws the error out of the promise rather than resolving with
a partial result.
([`src/Orchestrator.ts:140-204`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/Orchestrator.ts#L140-L204),
[`src/run.ts:790-797`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/run.ts#L790-L797))

This is precisely the failure mode our own `attempt()` exists to avoid, in its own words: "A
container that throws is a failed run, not a failed sandbox... Losing all three [commits, output,
tokens] because the process exited non-zero is the silent failure this adapter exists to avoid."
(`container-sandbox.ts:242-254`). Recovering commits from a `preservedWorktreePath` by hand is
possible; recovering the token spend is not — it was never captured anywhere durable.

### 6. Credentials — subscription OAuth token, never a metered API key

**Answered: supported, with one regression.** `.sandcastle/.env` scaffolding treats
`CLAUDE_CODE_OAUTH_TOKEN` as the primary credential ("run `claude setup-token` on your host... paste
the result into CLAUDE_CODE_OAUTH_TOKEN"), with `ANTHROPIC_API_KEY` offered only as a commented-out
alternative. `EnvResolver.resolveEnv` reads `.sandcastle/.env`, falling back to `process.env` per
declared key.
([`src/InitService.ts:418-430,650,670`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/InitService.ts#L418-L430),
[`src/EnvResolver.ts:49-73`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/EnvResolver.ts#L49-L73))

The regression: our adapter passes `--env GH_TOKEN` (name only) so docker reads the value from its
own inherited environment — the secret never appears as a `docker` command-line argument
(`container-sandbox.ts:505-521,619`). Sandcastle's `startContainer` does `-e KEY=value` for every
resolved variable, including the OAuth token — the literal secret is placed on the `docker run`
command line, readable via `ps aux`/`/proc/<pid>/cmdline` by anything else on the host for as long as
that process is visible.
([`src/DockerLifecycle.ts:126-129,156-171`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/DockerLifecycle.ts#L126-L129))

### 7. Review run — checkout mounted read-only, distinct per-run credential (`GH_REVIEW_TOKEN`)

**Answered: the credential swap is possible; the read-only mount is not, for the primary checkout.**
`MountConfig.readonly` exists, but only for *extra* mounts a caller adds via `DockerOptions.mounts`
— the primary worktree mount that `WorktreeManager`/`resolveGitMounts`/`SandboxFactory` build carries
no `readonly` field at all (`MountEntry` is just `{ hostPath, sandboxPath }`), so there is no way,
through sandcastle's own API, to make the checked-out worktree itself read-only.
([`src/MountConfig.ts`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/MountConfig.ts),
[`src/SandboxFactory.ts:254-257`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/SandboxFactory.ts#L254-L257))

A distinct per-run credential (our `GH_REVIEW_TOKEN`) is achievable: both `docker({ env })` and the
agent provider's own `env` option can be set per call, so a caller could pass a different, scoped
token per invocation. That is caller-assembled, not a first-class "review mode" the way `Mount`/
`envFor` is in our adapter.

### 8. Per-run CLI flags — `--model`, `--max-budget-usd`, `--permission-mode bypassPermissions`

- **`--model`**: passed through unchanged — `claudeCode(model, options)` puts it straight on the
  command line.
  ([`src/AgentProvider.ts:1181-1213`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L1181-L1213))
- **`--permission-mode bypassPermissions`**: supported directly as one of `permissionMode`'s allowed
  values, and functionally sandcastle's own AFK default (`--dangerously-skip-permissions`) is the
  same posture unless a `permissionMode` is set.
  ([`src/AgentProvider.ts:1167-1178,1196-1206`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L1167-L1178))
- **`--max-budget-usd`**: **absent.** No spend-ceiling concept exists anywhere in sandcastle — no
  flag, no option, no hook (confirmed by searching every source file for `budget`/`spend`/
  `max-budget`). `claudeCode()`'s `buildPrintCommand` only ever emits the fixed set of flags it knows
  about; there is no generic passthrough for an arbitrary CLI flag, so this cannot be bolted on from
  the caller's side either.
  ([`src/AgentProvider.ts:1197-1213`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L1197-L1213))

### 9. Signals the adapter reads — stderr model-refusal tag, `permission_denials`, never-started vs. exited-non-zero

- **stderr / unrecognised-model tag**: stderr is captured and, on a non-zero exit, preferred as the
  error detail, so the raw `[claude-code:unrecognized_model]` text would be present somewhere in the
  thrown `AgentError`'s message — but nothing parses it into a structured signal; a caller would have
  to regex the exception message themselves, with no equivalent of `modelRefused`.
  ([`src/Orchestrator.ts:191-205`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/Orchestrator.ts#L191-L205);
  compare [`container-sandbox.ts:287-299`](../../src/adapters/container-sandbox.ts#L287-L299))
- **`permission_denials`**: **not read anywhere.** `parseStreamJsonLine` extracts only assistant
  text/tool-calls, the terminal `result` string, and the `system init` session id from each
  stream-json line — every other field, including any permission-denial data Claude's envelope
  carries, is discarded. A run refused every tool it needed would report only whatever prose the
  agent produced — exactly the failure our own `deniedTools()` exists to prevent.
  ([`src/AgentProvider.ts:66-119`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L66-L119);
  compare [`container-sandbox.ts:773-804`](../../src/adapters/container-sandbox.ts#L773-L804))
- **never-started vs. exited-non-zero**: architecturally different from ours, and weaker. Sandcastle's
  Docker provider runs a *long-lived* container (`docker run -d`) and then `docker exec`s the agent
  into it, so `docker run`'s reserved exit codes (125–127, what `dockerNeverRan` checks) don't apply
  the same way. A `docker run -d` failure (bad image, daemon down) does throw a clean `DockerError`
  before any container exists — a genuine setup-failure signal — but a `docker exec` that starts and
  fails immediately (say, no credential) is reported exactly like any other agent failure: a
  non-zero exit becomes `AgentError`, indistinguishable from "the agent tried and gave up." There is
  no equivalent of `AgentNeverRan`.
  ([`src/sandboxes/docker.ts:179-199`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/docker.ts#L179-L199);
  compare [`container-sandbox.ts:596-602`](../../src/adapters/container-sandbox.ts#L596-L602))

### 10. Running as the invoking developer's uid; behaviour under root

Covered in finding 4: supported for the ordinary case (defaults to `process.getuid()`/`getgid()`,
verified against the image at a pre-flight check), unguarded for root — sandcastle does not refuse or
name uid 0 as a cause of failure the way our adapter does.

## Recommendation: don't swap

Sandcastle solves the one problem that drove our adapter away from worktrees in the first place — the
dot-git pointer — more cleanly than a full clone would (shared objects, faster setup, a worktree that
persists for follow-up work). It also matches our model flag, permission-mode flag, subscription
credential, and build-time-image constraints well enough to be viable in principle.

But of the four questions added during triage — the ones that exist precisely because the adapter
grew *after* this ticket was written — it fails three outright and only partially answers the fourth:
no way to mount the primary checkout read-only for a review, no spend ceiling of any kind, no
`permission_denials` signal, and no distinction between a run that never started and one that ran and
gave up. The missing spend ceiling is disqualifying on its own terms: our own vocabulary calls it
"the only thing bounding a run once it has started," and sandcastle has nothing that plays that role
— not a different flag, not a hook, nothing. Layered on top, a failed run's commits, output and spent
tokens are thrown away by default (finding 5) — the exact silent-failure mode our adapter's own
`attempt()` function exists to prevent.

None of these are exotic asks — sandcastle's own error types (`StructuredOutputError` already carries
`commits`/`branch`/`preservedWorktreePath`) show the vocabulary for most of this already exists in the
project — but none of it is built today. Adopting sandcastle now would mean writing and maintaining a
comparable amount of wrapper code around it (a spend-ceiling watchdog external to the CLI, a
permission-denial parser, a never-started classifier, a read-only mount for reviews) rather than
deleting the code we have. That is not a swap; it is our adapter, rehosted, on top of someone else's
worktree-and-container plumbing, with the failure paths still ours to write.

**What would reverse this.** If sandcastle ships (a) a way to bound a run's spend that the Claude Code
provider itself enforces, and (b) `commits`/`usage`/output surviving a non-zero exit instead of being
thrown away — those two have to land together, since a spend ceiling is pointless if the result that
proves it fired is discarded — the case gets much stronger. A `readonly` option on the primary
worktree mount and a structured `permission_denials`/model-refusal result would close the rest of the
gap. Given the project went quiet for the two and a half months before this research, re-confirm
those still hold, and re-confirm the project is still moving, before relying on this write-up again.

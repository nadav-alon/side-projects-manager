# The sandbox image every run happens in (see CONTEXT.md: Sandbox, Harness).
# The harness — the mattpocock-skills plugin the engineering skills ship as —
# is installed here, at build time, so a run never reinstalls it. Installing
# a plugin is a git clone plus a local file write with no Anthropic call in
# it, so the build needs no credential; only running the built image does,
# via the CLAUDE_CODE_OAUTH_TOKEN environment variable at `docker run` time.
FROM node:22-slim

# git and gh: the skills the harness ships shell out to both for every
# tracker and branch operation (docs/agents/issue-tracker.md). git doubles
# as how the plugin install below clones the marketplace. jq: the rebase
# workflow's script (`.github/workflows/scripts/rebase.sh`) shells out to it,
# and `npm test` exercises that script for real here.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# A Java 21 runtime: the Firebase emulators are Java programs, and a project
# whose security rules are tested against the Firestore emulator can only run
# those tests where Java is. Without it the agent writes rules tests it cannot
# run, and CI is the first place they ever execute. Copied from the Temurin
# image because firebase-tools refuses anything before 21 and this base's
# Debian release packages only 17.
COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# The CLI version is a build argument so the layer's cache key carries it.
# Installed unversioned, the command text never changes, so docker reuses the
# layer and a rebuild keeps whatever CLI the first build fetched, while the
# build reports success. `npm run sandbox:build` passes npm's current release,
# so a rebuild after a CLI release reinstalls, and one before it stays cached.
# `latest` is only the fallback for a bare `docker build`, which caches the old way.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

# Everything from here down belongs to a non-root user, and the harness with
# it. Two reasons, and either alone would be enough:
#
#   - The CLI refuses `--permission-mode bypassPermissions` under root or sudo,
#     so an unattended run as uid 0 exits before it makes a single call — and
#     says so as plain text rather than the JSON envelope the manager parses,
#     which reads downstream as an agent that spent nothing and gave up.
#   - Everything the agent writes goes through a bind mount into the
#     developer's own filesystem, and files it leaves owned by root need sudo
#     to delete.
#
# `node`, uid 1000, is the user node:22-slim already ships. The harness has to
# be installed *as* that user rather than moved to it afterwards: root's home
# is mode 0700, so a harness installed into /root is unreadable by anyone else
# — an image that looks built and runs with no plugin, no skills and no model
# pin, which fails as a run that reads its ticket and does nothing.
#
# HOME declared explicitly because the manager pins the container's user to the
# developer's own uid (`dockerCommand`), and docker hands a uid it cannot find
# in /etc/passwd a home of `/`. Fixed here, the harness is where the CLI looks
# whatever uid runs it.
ENV HOME=/home/node
USER node

# Sonnet, pinned explicitly rather than left to the default: the mechanical
# half of the work stays on the cheap model (docs/specs/morning-loop.md).
# Written before the plugin install below, which merges its own keys
# (extraKnownMarketplaces, enabledPlugins) into this same file — writing it
# after would truncate those keys back out.
RUN mkdir -p "$HOME/.claude" && printf '{"model":"sonnet"}\n' > "$HOME/.claude/settings.json"

# Declared in the image rather than only passed to the install below, so the
# CI check reads which plugin to assert about off the image itself
# (scripts/verify-harness.ts) instead of restating the id and going stale.
ENV HARNESS_PLUGIN=mattpocock-skills@claude-plugins-official

# `install` enables the plugin as a side effect; a separate `enable` call
# fails the build with "already enabled".
RUN claude plugin marketplace add anthropics/claude-plugins-official \
    && claude plugin marketplace update claude-plugins-official \
    && claude plugin install "$HARNESS_PLUGIN" -y

# The skill for a run that applies a pull request's review. It is invoked as
# `/apply-pr-review <pull request url>` rather than discovered by the model
# (the skill's own `disable-model-invocation: true`), so it only has to be
# present on disk, not enabled like the plugin above. Copied here rather than
# left for a project clone to carry one: the clone mounted at /repo is the
# *target* project being reviewed, which has no reason to ship a skill about
# this manager's own workflow. The CLI's personal-skill directory is where it lands instead, so
# it is found whichever project is mounted — scripts/verify-harness.ts asserts
# the file survived the build.
COPY --chown=node:node .claude/skills/apply-pr-review/SKILL.md $HOME/.claude/skills/apply-pr-review/SKILL.md

# The skill for a run that rebases a pull request's branch onto its base. Same
# reasoning as apply-pr-review just above.
COPY --chown=node:node .claude/skills/rebase-pr/SKILL.md $HOME/.claude/skills/rebase-pr/SKILL.md

# A run's whole product is commits, and git refuses to make one without an
# identity. Set in the image rather than per run, so every run's commits are
# attributable to the manager rather than to whoever built the image.
#
# Kept in step with SANDBOX_GIT_IDENTITY in src/adapters/container-sandbox.ts,
# which the sandbox's own salvage commits use — the two cannot share one
# constant across a Dockerfile and TypeScript, so change one and change the
# other.
#
# safe.directory: the clone arrives as a bind mount owned by whoever owns it on
# the host, which need not be the user in here — the manager's pin makes the
# two match, but a run without one (a host that reports no uid, or a bare
# `docker run`) lands on somebody else's repository as far as git is concerned,
# and git refuses to touch it.
RUN git config --global user.name "side-projects-manager" \
    && git config --global user.email "manager@side-projects.invalid" \
    && git config --global --add safe.directory /repo

# The harness is installed by uid 1000 but read — and written: the CLI keeps
# its own state alongside it — by whichever uid the manager pins, which is the
# developer's and need not be 1000. So the home holding it is opened to any
# uid, which is what makes the pin above safe to vary. Done as `node`, who owns
# all of it; the alternative, leaving it at 0700 like /root, is the failure the
# comment above the USER line describes.
#
# Reading it would survive this line being dropped — the harness is 0755 either
# way — so what asserts it is `npm run sandbox:verify:pinned`, which runs the
# check as a uid the image has never heard of and writes as it.
RUN chmod -R a+rwX "$HOME"

# A run whose API response goes quiet mid-stream is otherwise unbounded: the
# CLI's own mid-stream byte watchdog can end it, but whether that watchdog is
# on by default is the remote flag `tengu_stream_watchdog_default_on` — not
# ours to leave a three-hour hang to. Pinned on here so it fires whatever that
# flag says. The idle window is pinned to the CLI's own first-party default
# (180000ms, i.e. 180s) rather than a homemade number, so this pin changes a
# run's behaviour only where the remote flag would have moved it anyway.
# scripts/verify-harness.ts asserts both reach a container started from this
# image, the same way it asserts everything else the build put there.
ENV CLAUDE_ENABLE_BYTE_WATCHDOG=1
ENV CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=180000

# ENTRYPOINT rather than CMD: `docker run <image> -p "…" …` reads as invoking
# claude directly, matching how it's invoked outside a container. No ENV for
# CLAUDE_CODE_OAUTH_TOKEN here — `claude` itself reads it from the environment
# at startup (see the credential comment at the top of this file); declaring
# it, even with an empty default, trips Docker's secrets-in-ENV lint.
WORKDIR /repo
ENTRYPOINT ["claude"]

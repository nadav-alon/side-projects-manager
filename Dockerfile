# The sandbox image every run happens in (see CONTEXT.md: Sandbox, Harness).
# The harness — the mattpocock-skills plugin the engineering skills ship as —
# is installed here, at build time, so a run never reinstalls it. Installing
# a plugin is a git clone plus a local file write with no Anthropic call in
# it, so the build needs no credential; only running the built image does,
# via the CLAUDE_CODE_OAUTH_TOKEN environment variable at `docker run` time.
FROM node:22-slim

# git and gh: the skills the harness ships shell out to both for every
# tracker and branch operation (docs/agents/issue-tracker.md). git doubles
# as how the plugin install below clones the marketplace.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Sonnet, pinned explicitly rather than left to the default: the mechanical
# half of the work stays on the cheap model (docs/specs/morning-loop.md).
# Written before the plugin install below, which merges its own keys
# (extraKnownMarketplaces, enabledPlugins) into this same file — writing it
# after would truncate those keys back out.
RUN mkdir -p /root/.claude && printf '{"model":"sonnet"}\n' > /root/.claude/settings.json

# Declared in the image rather than only passed to the install below, so the
# CI check reads which plugin to assert about off the image itself
# (scripts/verify-harness.ts) instead of restating the id and going stale.
ENV HARNESS_PLUGIN=mattpocock-skills@claude-plugins-official

# `install` enables the plugin as a side effect; a separate `enable` call
# fails the build with "already enabled".
RUN claude plugin marketplace add anthropics/claude-plugins-official \
    && claude plugin marketplace update claude-plugins-official \
    && claude plugin install "$HARNESS_PLUGIN" -y

# TODO[#7]: nothing in this image sets a non-root user or a git identity.

# ENTRYPOINT rather than CMD: `docker run <image> -p "…" …` reads as invoking
# claude directly, matching how it's invoked outside a container. No ENV for
# CLAUDE_CODE_OAUTH_TOKEN here — `claude` itself reads it from the environment
# at startup (see the credential comment at the top of this file); declaring
# it, even with an empty default, trips Docker's secrets-in-ENV lint.
WORKDIR /repo
ENTRYPOINT ["claude"]

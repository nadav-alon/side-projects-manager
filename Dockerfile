# syntax=docker/dockerfile:1.7
#
# The sandbox image every run happens in (see CONTEXT.md: Sandbox, Harness).
# The harness — the mattpocock-skills plugin the engineering skills ship as —
# is installed here, at build time, so a run never reinstalls it. Building
# needs a one-year subscription token (`claude setup-token`) passed as a
# BuildKit secret, used only to fetch the plugin and never persisted in a
# layer; running the built image needs its own token, supplied as the
# CLAUDE_CODE_OAUTH_TOKEN environment variable at `docker run` time.
FROM node:22-slim

# git and gh: the skills the harness ships shell out to both for every
# tracker and branch operation (docs/agents/issue-tracker.md).
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
# Written before the plugin install below, which merges enabledPlugins into
# this same file — writing it after would truncate that key back out.
RUN mkdir -p /root/.claude && printf '{"model":"sonnet"}\n' > /root/.claude/settings.json

# The build-time token never lands in a layer: it only ever exists in the
# secret mount, and any credential file the CLI derives from it is deleted
# in this same layer before the mount unmounts.
RUN --mount=type=secret,id=claude_oauth_token \
    export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/claude_oauth_token)" \
    && claude marketplace add anthropics/claude-plugins-official \
    && claude plugin install mattpocock-skills@claude-plugins-official -y \
    && claude plugin enable mattpocock-skills@claude-plugins-official \
    && rm -f /root/.claude/.credentials.json

# TODO[#7]: sandcastle should run this with --user matching the mounted
# worktree's owner, and supply GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL — nothing in
# this image sets a non-root user or a git identity.
WORKDIR /repo
ENTRYPOINT ["claude"]

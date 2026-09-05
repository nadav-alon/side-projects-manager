# Side Projects Manager

Shared files for coding side projects: workflow, harnesses, agentic principles.

## Agent skills

The four files under `docs/agents/` are also the uniform half of the harness: `new-project` copies
them byte for byte into every project it scaffolds. Editing one changes what every project reads, so
keep them true of any repo — nothing in them may name this one.

### Coding standards

Branded primitives over bare ones, and comments that outlive the review (`TODO[#n]`, never ticket
narration). See `docs/agents/coding-standards.md`.

### Issue tracker

Issues live as GitHub issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

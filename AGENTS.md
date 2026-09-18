# Side Projects Manager

Shared files for coding side projects: workflow, harnesses, agentic principles.

## Agent skills

The files under `docs/agents/`, with `.github/workflows/apply-review.yml` and
`.github/workflows/rebase.yml`, are also the uniform half of the harness (`UNIFORM_FILES`):
`new-project` copies them byte for byte into every project it scaffolds. Editing one changes what
every project reads, so keep them true of any repo — nothing in them may name this one.

### Coding standards

Branded primitives over bare ones, and comments that outlive the review (`TODO[#n]`, never ticket
narration). See `docs/agents/coding-standards.md`.

### Issue tracker

Issues live as GitHub issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Ticket scope

One seam per ticket: acceptance criteria describe behaviors of one seam, never a list of them. See
`docs/agents/ticket-scope.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Apply review

Commenting `/apply-review` on a draft pull request opens a ticket asking an agent to work every open
review thread on it. See `.github/workflows/apply-review.yml`.

### Rebase

Commenting `/rebase` on a draft pull request opens a ticket asking an agent to rebase it. See
`.github/workflows/rebase.yml`.

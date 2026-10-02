# Side Projects Manager

Shared files for coding side projects: workflow, harnesses, agentic principles.

## Agent skills

The files under `docs/agents/`, with `.github/workflows/apply-review.yml`,
`.github/workflows/rebase.yml` and `.github/workflows/scripts/rebase.sh`, are also the uniform half
of the harness (`UNIFORM_FILES`): `new-project` copies them byte for byte into every project it
scaffolds. Editing one changes what every project reads, so keep them true of any repo — nothing in
them may name this one.

### Coding standards

Branded primitives over bare ones, and comments that outlive the review (`TODO[#n]`, never ticket
narration). See `docs/agents/coding-standards.md`.

### Issue tracker

Issues live as GitHub issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Ticket scope

One seam per ticket: acceptance criteria describe behaviors of one seam, never a list of them. See
`docs/agents/ticket-scope.md`.

### Sizing tickets here

Size a ticket in this repo one step larger than the same change would be in a project: `size:M`
where a project's would be `size:S`. Its runs cost about twice a project's at the same label,
because a change here usually spans the loop, the summary and the uniform files at once. The size
labels themselves are `docs/agents/triage-labels.md`'s.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Apply review

Commenting `/apply-review` on a draft pull request opens a ticket asking an agent to work every open
review thread on it. See `.github/workflows/apply-review.yml`.

### Rebase

Commenting `/rebase` on an open pull request, draft or ready, opens a ticket asking an agent to
rebase it — leaving its draft state as it was — and labels the pull request `needs-rebase`. See
`.github/workflows/rebase.yml`, whose logic is `.github/workflows/scripts/rebase.sh`.

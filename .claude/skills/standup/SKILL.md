---
name: standup
description: Report what every registered side project is waiting on the developer for, then rapid-fire the decisions and apply the answers to the tracker. Use when the developer asks for status, what's waiting, what's blocked, or to rapid-fire their stuff.
---

Two phases: a **standup** report, then **rapid fire** through what only the developer can decide. Run from the manager home, where `registry.json`, `journal.json` and `trigger.log` live. The labels are `docs/agents/triage-labels.md`'s; the terms (turbo, turboable, hand back) are `CONTEXT.md`'s.

## 1. Gather

For every repo in `registry.json`:

- Open pull requests: draft or ready, `mergeable`, labels.
- Open issues with labels.
- Blockers of every `ready-for-agent` ticket the last `Passed over` line of `trigger.log` names:

  ```sh
  gh api graphql -f query='{repository(owner:"O",name:"R"){issue(number:N){blockedBy(first:10){nodes{number state repository{name}}}}}}'
  ```

- For every repo `registry.json` marks `ui: true`, the UI changes since its last UX review and, separately, since its last design review. Each kind has its own base: the last review of a kind is the most recently closed ticket carrying its label, `ux-review` or `design-review` (`gh issue list --repo O/R --label ux-review --state closed --json number,closedAt`, and the same with `design-review`). Either kind ends in hand-back as `ready-for-human`, so it counts only once the developer closes it. Run the steps below once per kind. With none of that kind closed, `<base>` is the repo's first commit (`git rev-list --max-parents=0 <default>` on a clone, or the last page of `commits`). Otherwise `<base>` is the commit on the default branch (`<default>`, from `gh repo view O/R --json defaultBranchRef`) at that ticket's `closedAt`. List and diff only the UI files (`.tsx`, `.css`, `.html`, the one set this bullet names):

  ```sh
  gh api -X GET repos/O/R/commits -f sha=<default> -f until=<closedAt> -f per_page=1 --jq '.[0].sha'
  gh api -X GET "repos/O/R/compare/<base>...<default>" -f per_page=100 -f page=N --jq '.files[] | select(.filename|test("\\.(tsx|css|html)$")) | {filename,patch}'
  ```

  The SHA the first command prints is `<base>`. Page the compare until a page returns fewer than 100 files. A file without a `patch`, or a compare that reaches 300 files, is too big to summarise: offer the review anyway, naming the file or the cut-off.

  Read the patches and summarise which screens changed. No UI file in the diff means no change to offer a review for.

- Latest `journal.json` records and the `trigger.log` tail: what the loop last worked, and whether it is idling on a dry queue.
- The newest loop summary issue in the manager repo: its **Waiting on you** and **Discoveries** sections.

Check against what the report will claim: a PR rebased an hour ago may conflict again after a merge since; a blocker may have closed since the log line.

## 2. Status report

Three buckets, each item a link-worthy `repo#n` with the one fact that makes it the developer's:

- **Waiting on you**: ready pull requests, conflicting ones, `ready-for-human`, `needs-triage`, `needs-grilling` (count per repo), questions a discovery left on a ticket, open loop summaries.
- **Blocked**: dependency chains, written as `#6 → #7 → #8`, naming which link is free now.
- **Next**: what the next loop run should pick, and any budget overrun a summary reported.

## 3. Rapid fire

Rounds of `AskUserQuestion`, up to four questions each, ordered by how much each answer unblocks. Every option is a concrete action with the recommended one first, marked `(Rec)`. Covers `needs-triage`, `ready-for-human` that an agent could take, discovery questions, duplicates, and housekeeping (closing read summaries). `needs-grilling` issues get offered to the `grilling` skill instead: they are trees, not one question.

For each `ui: true` project with any UI-file change since its last UX review, offer a UX review: show the diff of the UI files and your summary of which screens changed, and let the developer decide. Offer a design review the same way, from the diff since its last design review; the two are separate offers, each answered on its own, though one question for the project may carry both. Only a UI-file change triggers an offer, so a project with none gets none. Offer none of a kind either where a ticket of that label is already open.

Before asking, read the whole issue and verify its premise is still live. A ticket may already record its decision (a `## Decision` section), or the release it waits on may already exist; then the question dissolves into an action and is never asked.

When an answer is "don't understand", re-ask in plain words with the concrete incident behind the issue, not the mechanism.

## 4. Apply

After each round, before the next:

- Record the decision on the issue: `Decision (developer, <date>): …` carrying only the points the developer's answer covered. Everything you filled in yourself (scope, which file first, an edge case) goes under `Still assumed:` in the same comment; a blanket "do the rest" answers none of it.
- An approved UX review or design review is filed as a new issue in that project, naming the screens to walk, in this order: create it labelled `ux-review` or `design-review`; link every implementation ticket already `ready-for-agent` in that project (not itself a `ux-review` or `design-review`) as a blocker with the `blocked_by` call below; grant `turboable` with `npm run grant`, as below; only then add `ready-for-agent`, so the ticket is never ready while unblocked.
- Relabel `needs-triage` / `ready-for-human` → `ready-for-agent` once the ticket is one seam (`docs/agents/ticket-scope.md`).
- A decision spanning repos splits: a new ticket in the repo that owns the change, and the original narrowed and blocked by it:

  ```sh
  gh api -X POST repos/O/R/issues/N/dependencies/blocked_by -F issue_id=<blocker's REST id>
  ```

- An answer that contradicts an ADR splits off as its own `needs-grilling` ticket, naming the ADR; the rest proceeds.
- Duplicates close as `not planned`, pointing at the survivor.
- Asked to put a chain on turbo: grant every ticket in it `turboable` now, before any of their runs start (a later grant reads as no consent), and only on a project `registry.json` marks turbo. Grant each with `npm run grant -- owner/repo#n`, never a bare `gh issue edit --add-label`, so a grant made inside a run span can still count. A ticket already carrying `turboable` gets no new `labeled` event from a grant, so flag it to the developer rather than assuming the grant counts.

Finish once every item in **Waiting on you** has been asked, applied, or deliberately left with the developer. Re-list the labels across all repos to confirm (`gh issue list` lags an edit by seconds; `gh issue view` per issue does not), then report what moved and what still needs the developer.

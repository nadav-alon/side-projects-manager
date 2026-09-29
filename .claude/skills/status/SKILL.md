---
name: status
description: Report what every registered side project is waiting on the developer for, then rapid-fire the decisions and apply the answers to the tracker. Use when the developer asks for status, what's waiting, what's blocked, or to rapid-fire their stuff.
---

Two phases: a **status** report, then **rapid fire** through what only the developer can decide. Run from the manager home, where `registry.json`, `journal.json` and `trigger.log` live. The labels are `docs/agents/triage-labels.md`'s; the terms (turbo, turboable, hand back) are `CONTEXT.md`'s.

## 1. Gather

For every repo in `registry.json`:

- Open pull requests: draft or ready, `mergeable`, labels.
- Open issues with labels.
- Blockers of every `ready-for-agent` ticket the last `Passed over` line of `trigger.log` names:

  ```sh
  gh api graphql -f query='{repository(owner:"O",name:"R"){issue(number:N){blockedBy(first:10){nodes{number state repository{name}}}}}}'
  ```

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

Before asking, read the whole issue and verify its premise is still live. A ticket may already record its decision (a `## Decision` section), or the release it waits on may already exist; then the question dissolves into an action and is never asked.

When an answer is "don't understand", re-ask in plain words with the concrete incident behind the issue, not the mechanism.

## 4. Apply

After each round, before the next:

- Record the decision on the issue: `Decision (developer, <date>): …`, with enough for an agent to write the change.
- Relabel `needs-triage` / `ready-for-human` → `ready-for-agent` once the ticket is one seam (`docs/agents/ticket-scope.md`).
- A decision spanning repos splits: a new ticket in the repo that owns the change, and the original narrowed and blocked by it:

  ```sh
  gh api -X POST repos/O/R/issues/N/dependencies/blocked_by -F issue_id=<blocker's REST id>
  ```

- An answer that contradicts an ADR splits off as its own `needs-grilling` ticket, naming the ADR; the rest proceeds.
- Duplicates close as `not planned`, pointing at the survivor.
- Asked to put a chain on turbo: label every ticket in it `turboable` now, before any of their runs start (a later label reads as no consent), and only on a project `registry.json` marks turbo.

Finish once every item in **Waiting on you** has been asked, applied, or deliberately left with the developer. Re-list the labels across all repos to confirm (`gh issue list` lags an edit by seconds; `gh issue view` per issue does not), then report what moved and what still needs the developer.

---
name: resolve-discoveries
description: Answer the discoveries waiting on the developer, the loop pane's list, ticket by ticket, and apply each answer to the tracker. Use when the developer asks to resolve, handle or clear their discoveries.
---

A **standup** narrowed to one queue: the discoveries recorded in `recorded-discoveries.json` in the manager home, the list the loop pane draws. Rapid fire and Apply are the standup's (`.claude/skills/standup/SKILL.md`, §3 and §4), followed exactly; this skill sets only what is gathered and when a discovery is done. **Discovery** and its four kinds are `CONTEXT.md`'s.

## 1. Gather

Read `recorded-discoveries.json` and group its entries by ticket. For each discovery, read where its kind landed it:

- **correction**, **clarification**: a comment on the ticket, headed by the recorded title.
- **prerequisite**: a discovered ticket blocking it, or a comment naming an already-open blocker.
- **suggestion**: a discovered ticket ("Discovered while working #N").

Then the ticket the filing run was working, which the comment's "Discovered while working #N" names. A blocking kind (correction, prerequisite) handed that ticket back: an implementation ticket, or a review or apply-review ticket whose pull request is still a draft.

Gathering is done when every discovery has its premise checked against the tracker as it stands now: a later `Decision (developer, …)` comment that answers it, a pull request that merged since, a run that already acted on its own reading. A discovery whose premise has dissolved gets no question; it goes straight to Apply.

## 2. List

One line per discovery: `repo#n [kind]`, then the one decision it needs, or why it needs none ("answered 2026-11-14", "the run acted on its reading in #268").

## 3. Rapid fire and Apply

As the standup does, rounds of up to four, most-unblocking first. What each kind asks:

- **correction**: accept the run's reading, reword the ticket, or overrule it.
- **clarification**: confirm how the run read the ticket, or give another reading.
- **prerequisite**: who does it (agent or developer), and whether its blocker edge stands.
- **suggestion**: triage the discovered ticket: labels, size, turbo, or close.

Apply each answer where a later run reads it: the `Decision (developer, <date>)` comment on the ticket the discovery is about, and, when that ticket's pull request is still a draft, a review thread on the pull request too, so its next apply-review run carries it out. A handed-back ticket whose discovery is now answered goes back to `ready-for-agent`, granted as the standup grants.

## 4. Drop

A discovery is done once its answer is applied. Drop it from the pane with `npm run drop-discovery -- owner/repo#n`, which drops every discovery on that ticket, so run it once all of that ticket's are answered. TODO[#1858]: until that command lands, a discovery leaves the pane only when its ticket closes or leaves `ready-for-human`; name the ones that will stay listed.

Finish when every recorded discovery is answered and applied, or left with the developer by their choice. Re-read `recorded-discoveries.json` and tell the developer what is still listed and why.

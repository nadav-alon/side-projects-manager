# Can sub-issues and `blocked_by` edges cross repos, and what does selection do with them?

Research for #913 (map #911). The map lives in this repo; build tickets will live in child repos.
Two halves: what GitHub allows, and what the loop's code (pinned to `89d2a3a`) does with it today.

## Answer

- **Sub-issues cross repos, same owner only.** The REST docs for `sub_issue_id` say "The sub-issue
  must belong to the same repository owner as the parent issue". A map here can hold child-repo
  tickets as sub-issues, as long as the child repos are under `nadav-alon`.
- **`blocked_by` edges cross repos (same owner confirmed).** Nothing in the docs restricts them, and
  live data shows many same-owner edges across repos. Across owners: not documented, not seen in a
  sample, not tested.
- **The loop already respects blockers**, including blockers in other repos: a ticket with any open
  blocker is set aside. But a blocker or parent in another repo passes on nothing else: no priority,
  no parent lookup. And `listSubIssues` tags every sub-issue with the parent's repo, which is wrong
  for a sub-issue that lives in another repo.

## GitHub: sub-issues

Source: [REST: sub-issues](https://docs.github.com/en/rest/issues/sub-issues),
[Adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues).

- **Cross-repo:** `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`, body
  `sub_issue_id` (the issue's **database id**, not its `#number`). The docs say: "The sub-issue must
  belong to the same repository owner as the parent issue". The UI docs say: "To add issues from
  other repositories, click [back] next to the repository name and select a different repository."
  - Same owner, different repo: allowed.
  - Different owner: refused.
- **Other fields:**
  - `replace_parent` (bool) moves a sub-issue that already has a parent. An issue has at most one
    parent.
  - GraphQL `addSubIssue` takes `issueId` plus `subIssueId` **or** `subIssueUrl`, and `replaceParent`
    (schema introspection, run 2026-09-26).
- **Other endpoints:**
  - `GET .../sub_issues`: paginated, `per_page` max 100.
  - `GET .../parent`
  - `DELETE .../sub_issue`
  - `PATCH .../sub_issues/priority`: reorder, with `after_id` / `before_id`.
- **Errors:**
  - The add endpoint answers 403, 404, 410 or 422.
  - A cross-owner add is presumably 422. Not tested.
- **Limits:** 100 sub-issues per parent, 8 levels of nesting (UI docs). Adds are subject to
  secondary rate limiting.
- **Response shape:** each REST issue object carries `repository_url`, which names the sub-issue's
  own repo. `gh issue list --json parent` asks for `parent{id,number,title,url,state,repository{nameWithOwner}}`
  ([cli `api/query_builder.go` v2.95.0 L447-448](https://github.com/cli/cli/blob/v2.95.0/api/query_builder.go#L447-L448)).
- **Empirical:** the public `has:parent-issue` search sampled here (99 issues) had no cross-repo
  parent. This tells us nothing either way: the feature is documented, cross-repo parents are just
  uncommon.

## GitHub: issue dependencies (`blocked_by` / `blocking`)

Source: [REST: issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies),
[Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies),
[GA changelog 2025-08-21](https://github.blog/changelog/2025-08-21-dependencies-on-issues/).

- **REST:**
  - `GET|POST /repos/{o}/{r}/issues/{n}/dependencies/blocked_by`. POST takes `issue_id`, "The id of
    the issue that blocks the current issue", as a database id.
  - `DELETE .../blocked_by/{issue_id}`
  - `GET .../dependencies/blocking`
  - The lists are paginated, `per_page` max 100.
  - The blocker is identified only by its global database id, never by `owner/repo#n`. The path
    names the *blocked* issue's repo only.
- **GraphQL:**
  - `addBlockedBy(issueId, blockingIssueId)` / `removeBlockedBy`, taking node ids.
  - The `Issue.blockedBy` / `Issue.blocking` connections.
  - `Issue.issueDependenciesSummary {blockedBy, blocking, totalBlockedBy, totalBlocking}`. The schema
    describes the `total*` fields as "(open and closed)", so `blockedBy` counts **open** blockers
    only.
- **REST summary:** `issue_dependencies_summary {blocked_by, blocking, total_blocked_by,
  total_blocking}` is on every issue object (e.g. #918 here reads
  `blocked_by: 1, total_blocked_by: 1`, blocked by #913).
- **Cross-repo, same owner: yes, confirmed by live data.** A read-only GraphQL search of
  `is:blocked is:public` (894 issues) found 19 blocked by an issue in another repo of the same owner.
  Example: `briar-systems/mach-zed#65` is blocked by `briar-systems/mach-tree-sitter#38`, and its
  summary reads `blockedBy: 1`. **The summary counts a blocker in another repo like any other.**
- **Cross-owner: unknown.**
  - No doc statement either way. The REST docs name no owner restriction, unlike sub-issues.
  - 0 of 894 sampled edges crossed owners.
  - Not tested: it would mean writing an edge, and this ticket stayed read-only.
  - Treat it as unsupported until tested.
- **Visibility caveat:** `mistersilver-uk/fabricate#1962` has a summary of `blockedBy: 2`, but its
  `blockedBy` connection returns only 1 node. Most likely the other blocker is in a repo the reader
  cannot see. **The summary counts blockers the token cannot see. The connection lists only the ones
  it can see.**
- **Limits:** up to 50 issues per relationship type (changelog). `gh issue list --json blockedBy`
  asks for `blockedBy(first:50){nodes{id,number,title,url,state,repository{nameWithOwner}},totalCount}`
  ([query_builder.go L453-454](https://github.com/cli/cli/blob/v2.95.0/api/query_builder.go#L453-L454)),
  so `gh` returns every blocker there can be.
- **UI:** blocked issues get a "Blocked" icon on project boards and Issues lists. The sidebar's
  Relationships section offers "Mark as blocked by" / "Mark as blocking". The search qualifiers
  `is:blocked`, `is:blocking`, `blocked-by:` and `blocking:` exist (changelog). gh ≥ 2.94 has the
  `--blocked-by` / `--blocking` / `--parent` flags
  ([changelog 2026-06-10](https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/)).

## This repo: does selection respect blockers?

Yes. The chain:

1. `listOpenIssues` reads `gh issue list --json number,title,body,blockedBy,parent,labels`
   (`src/adapters/gh-issue-tracker.ts:91-106`).
2. It keeps the blockers whose `state === "OPEN"` and counts them into `Ticket.openBlockers`,
   **wherever they live** (`gh-issue-tracker.ts:112-115,124`). The port documents this on purpose
   (`src/ports/issue-tracker.ts:527-530`).
3. `isBlocked` reads `openBlockers > 0` (`src/ports/issue-tracker.ts:328-330`).
4. `scan` sets blocked tickets aside before `bestTicket` and reports them as `findings.blocked`
   (`src/selection.ts:376-386,397-402`).

So a child-repo ticket blocked by an open issue in the manager repo, or the other way round, is not
selected. It becomes selectable the morning after its blocker closes. This agrees with `CONTEXT.md`'s
"Blocked ticket".

One difference from `docs/agents/issue-tracker.md` ("Frontier query", which reads
`issue_dependencies_summary.blocked_by`): the adapter counts open blockers from the **`blockedBy`
node list**, not from the summary. Given the visibility caveat above, a blocker the `gh` token cannot
see would not count, and the ticket would read as unblocked. That doesn't matter for public repos
under one owner and one token.

## What a cross-repo blocker or cross-repo map breaks

The model is **one repo per scan, tickets keyed by bare `IssueNumber` inside it**:

- `scan` reads each registered project separately:
  `ports.tracker.listOpenIssues(project.repo)` (`src/selection.ts:298,311`).
- `OpenIssue.parent` and `openBlockerNumbers` are bare `IssueNumber`s
  (`src/ports/issue-tracker.ts:532-537`).
- The adapter drops any that are not in the same repo using `isInRepo`
  (`gh-issue-tracker.ts:116-118,128-129`, `isInRepo` at `:854-857`).

What follows from that:

1. **Ticket priority does not cross repos.** `ticketPrioritiesIn` passes priority from parent to
   sub-issue and from blocked issue to blocker, using only numbers in the same repo's listing
   (`src/ports/issue-tracker.ts:593-617`, doc at `:593-594`: "closed, in another repo, or not read —
   contributes nothing").
   - A `priority:N` label on the map in the manager repo never reaches its child-repo tickets.
   - A child-repo blocker never inherits the urgency of the ticket it blocks.
   - The blocker still gates selection. It just isn't pulled forward.
2. **Parent lookups fail across repos.** `parentTicketIn` (`src/ports/issue-tracker.ts:577-584`)
   resolves only a parent in the same repo. It is used by:
   - `implementationTicketFor` (`src/morning-run.ts:2164-2169`)
   - `discoveryTargetFor` (`src/discovery-routing.ts:226`)

   A pull-request ticket whose implementation ticket sits in another repo resolves to `undefined`.
   The same happens for a truncated backlog.
3. **`listSubIssues` gives cross-repo sub-issues the wrong repo.** The `--jq` projection drops
   `repository_url` (`gh-issue-tracker.ts:299-303`), and `subIssuesIn` sets every sub-issue's
   `repo: parent.repo` (`gh-issue-tracker.ts:951-954`). A child-repo sub-issue of a manager-repo
   supertask comes back as `nadav-alon/side-projects-manager#<child number>`: an existing issue, or a
   non-existent one.
   - The spec review sweep (`src/spec-review-sweep.ts:107-126`) only reads `closed`, so its gate still
     works.
   - `alreadySpecReviewed` and `specReviewBody` would read, and cite, the wrong issue.
   - This is the one real **bug** a cross-repo map would hit, if the map carried the `supertask`
     label. A wayfinder map doesn't today.
4. **The "missing supertask label" finding ignores cross-repo children.**
   - `hasNonPullRequestSubIssue` (`src/selection.ts:481-488`) and `hasOpenSubIssue` (`src/spec-review-sweep.ts:182`) look only at the
     same repo's listing.
   - A manager-repo map whose only children live in child repos never trips the finding.
   - Its pre-filter always passes, so `listSubIssues` decides every time. That is correct, but it
     costs a call.
5. **Links the loop writes stay in one repo.**
   - `discover` opens the discovered issue in `ticket.repo` (`gh-issue-tracker.ts:404-415`).
   - `blockOn` posts the edge under `ticket.repo` (`:462-471`).
   - `linkToParent` posts under `parent.repo` (`:701-716`).

   None of these makes a cross-repo edge today. `blockOn`/`linkToParent` would accept a cross-repo
   pair as they stand, since both endpoints take the other issue's database id, which works across
   repos.
   - The body fallback writes `Part of #N` (`:726`), which resolves in the child's own repo. For a
     cross-repo parent it should read `owner/repo#N`.
   - The fallback only runs where sub-issues are unavailable.
6. **`Ticket` identity is `(repo, number)`, but maps built by `IssueNumber` assume one repo**
   (`ticketPrioritiesIn` returns `Map<IssueNumber, …>`, `src/ports/issue-tracker.ts:601`). Each map
   is built per repo, so this is safe today. Bringing cross-repo edges into one graph means keying by
   `(repo, number)`, or by URL, first.

## What this means for #911's pilot

- Keep the manager and child repos under the **same owner** (`nadav-alon`): sub-issues require it,
  and blockers are only confirmed for it.
- Map → child-repo tickets as sub-issues: works on GitHub. The loop ignores the link except in
  `listSubIssues`, which gets the child's repo wrong (item 3).
- A child-repo build ticket blocked by a manager-repo decision ticket, or by another child repo's
  ticket: selection holds it back correctly today. Priority does not flow along that edge.
- Needs its own ticket if the pilot relies on it:
  - carrying the repo through `subIssuesIn`
  - `owner/repo#N` in the fallback body
  - priority and parent resolution across repos
- Untested and worth a short throwaway write if cross-owner ever matters: whether
  `POST .../dependencies/blocked_by` accepts an `issue_id` from another owner.

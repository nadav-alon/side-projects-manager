---
name: apply-pr-review
description: Act on a pull request's review — answer every open thread, apply or decline each comment, push the commits.
disable-model-invocation: true
---

Works one pull request's review to the end: every open **thread** gets a reply, and every reply says either **applied** (with the commit) or **declined** (with the reason). The branch is pushed; the pull request is otherwise left as it was. The pull request argument is the go-ahead for every step below. A run may be unattended, with nobody to answer a question, so each step carries straight into the next, ending only at a stop a step names or at the report.

The argument is the pull request (number or URL). With none, use the current branch's: `gh pr view --json number,url`. Name the repo explicitly (`--repo <owner>/<repo>`, or `repos/<owner>/<repo>` in `gh api`) whenever `origin` is not a GitHub remote.

## 1. Check out the branch

`gh pr checkout <pr>`, then `git pull --ff-only`. Done when the working tree is clean and `HEAD` matches the pull request's head commit (`gh pr view <pr> --json headRefOid`).

## 2. Collect the threads

One query gives both kinds of review comment:

```sh
gh api graphql -F owner=<owner> -F repo=<repo> -F pr=<number> -f query='
query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){
  reviewThreads(first:100){nodes{id isResolved isOutdated path line
    comments(first:50){nodes{databaseId author{login} body}}}}
  reviews(first:100){nodes{databaseId author{login} state body}}}}}'
```

A **thread** is either:

- an unresolved review thread, or
- a review with a non-empty top-level `body` (it has no thread of its own; its reply goes on the pull request).

Drop any thread whose last comment carries the marker `<!-- apply-pr-review -->`: it was answered by an earlier run of this skill and nobody has spoken since. Done when you hold a numbered list of every remaining thread: id, file and line (if any), and the full comment text.

If the list is empty, report that and stop.

## 3. Load what the review is judged against

- The ticket the pull request closes: read its body for `Closes #n` / `Fixes #n`, then `gh issue view <n>`.
- The repo's agent instructions and the coding standards and domain docs they point at.

These, not the reviewer's say-so, decide each thread.

## 4. Decide every thread

For each thread, one verdict:

- **Applied**: the comment is correct and within the ticket's scope. Where it is ambiguous, pick the reading the ticket and standards support, and say which in the reply.
- **Declined**: the comment is wrong about the code, contradicts the ticket or a documented standard, or asks for work outside the ticket. Out-of-scope work gets a suggested follow-up ticket in the reply; the ticket itself is the developer's to open.

Outdated threads are decided like any other: check whether the current code still has the problem. Done when every thread on the list has a verdict and a one-line reason.

## 5. Apply

Work the applied threads one at a time: make the change, run the repo's tests and type check, commit. One commit per thread; threads touching the same code may share one, named in its message. Every commit leaves the tests green.

A change that cannot be made green flips to **declined**: revert it and give the failure as the reason.

Done when every applied thread maps to a commit on the branch and the full test suite passes on `HEAD`.

## 6. Push

`git push` to the pull request's branch — a plain fast-forward push. If it is rejected, stop and report; the branch moved under you. Done when `gh pr view <pr> --json headRefOid` equals local `HEAD`.

## 7. Reply

Every reply ends with the marker line `<!-- apply-pr-review -->`.

- Applied: `Applied in <sha>: <what changed>.`
- Declined: `Declined: <reason>.`

Where it goes:

- Review thread: `gh api repos/<owner>/<repo>/pulls/<number>/comments/<databaseId of the thread's first comment>/replies -f body=<reply>`. Then, for applied threads only, resolve it: `gh api graphql -F id=<thread id> -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'`. Declined threads stay open for the reviewer to answer.
- Review body: `gh pr comment <pr> --body <reply>`, opening with a quote of the passage it answers.

Done when every thread from step 2 has exactly one reply posted.

## 8. Report

One line per thread: verdict, file:line or "review body", commit or reason. Then the pushed head commit.

The pull request's draft state, reviewers, and labels stay as they were: acting on a review ends at the push and the replies.

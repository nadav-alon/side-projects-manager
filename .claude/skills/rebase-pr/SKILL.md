---
name: rebase-pr
description: Rebase a pull request's branch onto its base, resolving conflicts and pushing only once tests and type check are green.
disable-model-invocation: true
---

Works one pull request's branch back onto its base, and stops there. The pull request argument is
the go-ahead for every step below. A run may be unattended, with nobody to answer a question, so
each step carries straight into the next, ending only at a stop a step names or at the report — as
the apply-pr-review skill says of itself.

The argument is the pull request (number or URL). With none, use the current branch's:
`gh pr view --json number,url`. Name the repo explicitly (`--repo <owner>/<repo>`, or
`repos/<owner>/<repo>` in `gh api`) whenever `origin` is not a GitHub remote.

## 1. Check out the branch

`gh pr checkout <pr>`, then `git pull --ff-only`. Done when the working tree is clean and `HEAD`
matches the pull request's head commit (`gh pr view <pr> --json headRefOid`).

## 2. Fetch the base and rebase onto it

Read the base branch: `gh pr view <pr> --json baseRefName`. `git fetch origin <base>`, then
`git rebase origin/<base>`. Done when the rebase finishes clean, or stops on the first conflicted
commit for step 3 to resolve.

## 3. Resolve conflicts

Before resolving anything, load what each resolution is judged against:

- The ticket the pull request closes: read its body for `Closes #n` / `Fixes #n`, then
  `gh issue view <n>`.
- The repo's own agent instructions and the coding standards and domain docs they point at.

These, not the shape of the diff, decide what each resolution should be.

Resolve the conflicts with `resolving-merge-conflicts` — a plugin skill, so it is addressed with its
plugin's prefix, the way the review runs invoke `/mattpocock-skills:code-review`:
`/mattpocock-skills:resolving-merge-conflicts`. That skill covers how a hunk gets resolved and how
the rebase gets finished end to end; nothing here restates it. It forbids `--abort`, and so does this
skill.

Done when the rebase reports no commits left to apply.

## 4. Verify green

Run the repo's tests and type check on the rebased `HEAD`. Red is not done.

A rebase that cannot be got green is a stop: report the conflicted file and why, and go no further.
Nothing is force-pushed. The half-finished rebase is left exactly where it is — the clone is thrown
away at the end of the run, so there is nothing to clean up — and this skill asks for neither
`--abort` nor `--skip` nor a pushed half-rebase.

## 5. Push

`git push --force-with-lease` to the pull request's branch. A rejected push means the branch moved
under you: stop and report, changing nothing else.

Done when `gh pr view <pr> --json headRefOid` equals local `HEAD`.

## 6. Report

The new head commit, the base branch it now sits on, and one line per conflicted file saying how it
was resolved.

The pull request's draft state, reviewers, labels, title and body are left as they were: rebasing
ends at the push.

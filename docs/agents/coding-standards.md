# Coding Standards

House rules for source in this repo. The `/code-review` standards axis reads this file.

## Brand your primitives

**Prefer a branded primitive over a bare `string` or `number` whenever the value has a shape,
a unit, or a source that the primitive itself doesn't express.**

A `string` says a value is text. It doesn't say it is `owner/repo` rather than a URL, a branch name,
or a repo's display name — and every one of those is a `string` too, so the compiler will hand you
any of them. Branding makes the type say what the value actually is, and forces every value to enter
through one checked door.

The pattern:

```ts
declare const repoSlugBrand: unique symbol;

export type RepoSlug = string & { readonly [repoSlugBrand]: true };

/** The guard. */
export function isRepoSlug(value: string): value is RepoSlug { … }

/** The constructor: narrows, or throws naming the offending value. */
export function repoSlug(value: string): RepoSlug { … }
```

Three things travel together, and a brand without all three is worse than no brand:

1. the branded type,
2. a **type guard** (`isX`), for values arriving from outside — parsed documents, CLI output, `JSON.parse`,
3. a **constructor** (`x`), which narrows or throws, for values written in source and tests.

The `declare const … : unique symbol` is type-only and erases, so branding stays compatible with
`erasableSyntaxOnly`. Never widen a brand back with a cast: if you need one, the guard is wrong or
the value genuinely isn't that thing.

**Brand when** the primitive has a format (`owner/repo`, a branch name, an issue URL), a unit
(tokens, milliseconds, a fraction), or an identity that must not be swapped with a sibling of the
same primitive type.

**Don't brand** a primitive whose only meaning is its type: a free-text ticket title, a count with no
unit ambiguity, a boolean.

## Comments outlive the review

A comment is read by whoever opens the file in a year, not by the reviewer reading the diff today.
Anything that only makes sense while the PR is open does not belong in the source.

**Write:**

- What the code is for, and why it is shaped the way it is.
- Contracts a caller can't see from the signature: what an empty result means, what is guaranteed.
- `TODO[#11]: re-check the gate between iterations.` — deferred work, tagged with its issue.

**Don't write:**

- Progress narration: _"Today this does X, because Y is #12."_
- Diff commentary: _"now corrected to…", "dropped the unused…", "renamed off…"._ That belongs in the
  commit message or the PR body, both of which are attached to the change rather than to the file.
- Ticket prose inside a doc comment: _"Running it is #7."_ Use `TODO[#7]`.

### `TODO[#n]`

The one sanctioned way to name unfinished work in source:

```ts
// TODO[#7]: run the selected ticket in the sandbox.
```

Grep-able, and the issue number is the whole explanation — don't restate the issue in the comment.
When the issue closes, the TODO goes with it. A `TODO` with no issue number is not allowed; if the
work isn't worth an issue, it isn't worth a `TODO`.

### Why this is a product concern, not just house style

Agents write code into this repo unattended, from a ticket. An agent narrating its own ticket into a
doc comment leaves that narration behind permanently, in a file nobody will revisit. The convention
is part of the harness the agents run under.

## Vocabulary

Names in source use the glossary in [`CONTEXT.md`](../../CONTEXT.md), including the synonyms it
tells you to avoid. Where the glossary distinguishes two terms, source may not blur them.

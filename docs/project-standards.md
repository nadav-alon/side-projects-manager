# Project standards

## Brand your primitives

**Prefer a branded primitive over a bare `string` or `number` whenever the value has a shape,
a unit, or a source that the primitive itself doesn't express.**

A `string` says a value is text. It doesn't say it is `owner/repo` rather than a URL, a branch name,
or a repo's display name — and every one of those is a `string` too, so the compiler will hand you
any of them. Branding makes the type say what the value actually is, and forces every value to enter
through one checked door.

Two patterns are accepted.

**No schema validates the primitive** — brand with a type-only marker:

```ts
declare const repoSlugBrand: unique symbol;

export type RepoSlug = string & { readonly [repoSlugBrand]: true };

/** The guard. */
export function isRepoSlug(value: string): value is RepoSlug { … }

/** The constructor: narrows, or throws naming the offending value. */
export function repoSlug(value: string): RepoSlug { … }
```

**A zod schema already validates the primitive** — brand the schema itself with `.brand<"X">()`,
so `safeParse`'s output carries the brand automatically. Keep the schema module-private so the
guard and constructor stay the only way in:

```ts
import { z } from "zod";

const emailSchema = z.string().email().brand<"Email">();

export type Email = z.infer<typeof emailSchema>;

/** The guard. */
export function isEmail(value: string): value is Email {
  return emailSchema.safeParse(value).success;
}

/** The constructor: narrows, or throws naming the offending value. */
export function email(value: string): Email {
  if (!isEmail(value)) throw new Error(`Not an Email: ${JSON.stringify(value)}`);
  return value;
}
```

Three things travel together either way, and a brand without all three is worse than no brand:

1. the branded type,
2. a **type guard** (`isX`), for values arriving from outside — parsed documents, CLI output, `JSON.parse`,
3. a **constructor** (`x`), which narrows or throws, for values written in source and tests.

The `declare const … : unique symbol` form is type-only and erases, so branding stays compatible
with `erasableSyntaxOnly`. The zod form has no such marker to erase — the brand rides on the schema
instead. Never widen a brand back with a cast: if you need one, the guard is wrong or the value
genuinely isn't that thing.

**Brand when** the primitive has a format (`owner/repo`, a branch name, an issue URL), a unit
(tokens, milliseconds, a fraction), or an identity that must not be swapped with a sibling of the
same primitive type.

**Don't brand** a primitive whose only meaning is its type: a free-text ticket title, a count with no
unit ambiguity, a boolean.

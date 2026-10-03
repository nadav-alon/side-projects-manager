---
status: accepted
---

# Project standards may override a uniform rule

The brand rules in `docs/agents/coding-standards.md` are TypeScript text, and that file is a uniform
file: copied byte for byte into every project, a C++ repo included. Each project now has its own
`docs/project-standards.md` (CONTEXT.md's "Project standards") for what is particular to its
language. Decided on #1212.

## Why it went this way

**Project standards may override a uniform rule, named and justified inline.** A contradiction that does
not name the rule it overrides loses to the uniform rule, and is a review finding. The seed is
written once by the scaffold and never synced, so it is the project's from then on.

## Considered options

- **Dropping `coding-standards.md` from the uniform files.** The language-neutral rules would lose
  their one channel; #1216 used it.
- **Keeping the file whole and deferring to an optional project file.** TypeScript text would sit in
  a C++ repo.
- **A language file that stays uniform, with projects opting in.** It needs per-project uniform
  lists, and reopens ADR 0011's uniform-only gate, for three TypeScript repos.

## What this costs

- An improvement to the brand rules reaches other projects by ticket, not by sweep.
- `new-project --standards` takes a preset name. `typescript` is the only preset and an unknown name
  is an error; another is added when a project in a second language is scaffolded.

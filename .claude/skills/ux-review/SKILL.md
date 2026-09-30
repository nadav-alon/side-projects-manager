---
name: ux-review
description: Walk a project's flows in a browser on a phone and a desktop, and report how the app feels — layout, ease of use, feedback, friction, copy, consistency.
disable-model-invocation: true
---

Reviews how one project's app feels to use, and stops there. The ticket argument is the go-ahead
for every step below. A run may be unattended, with nobody to answer a question, so each step
carries straight into the next, ending only at a stop a step names or at the report. Nothing is
committed, and no file in the project changes.

The argument is the ticket (number or URL). Name the repo explicitly (`--repo <owner>/<repo>`)
whenever `origin` is not a GitHub remote.

## 1. Read the ticket

`gh issue view <ticket>`. Take from it the flows or screens to walk and the scenario to seed the
app with. With no scenario named, use `owner-with-items`. Done when you hold a list of flows and
one scenario name.

## 2. Start the app

Check `package.json` for a `ux` script. With none, stop: hand back saying the project has no `ux`
script, and report nothing else.

Otherwise run `npm ci`, then `npm run ux -- --scenario <name>` in the background. Wait for the
URL it prints, and use that URL for every step below. Done when the URL answers.

## 3. Walk the flows

Drive the app with Playwright MCP, walking every flow from step 1 in this order:

1. An Android phone: 412×915 viewport, touch enabled. This pass comes first and gets the most
   attention; the app is used on a phone.
2. One desktop pass at 1280×800.

Each pass runs in the light theme and again in the dark one. Done when every flow has been walked
in all four combinations.

## 4. Judge feel only

Judge against this rubric, and nothing else:

- **Layout**: what overflows, crowds, or sits out of reach on the viewport.
- **Ease of use**: small or cramped targets; text that should be clickable but isn't; something
  clickable that doesn't look it; a gesture a person would expect (swipe, pull, long-press) that is
  missing; anything that works only on hover, on a touch viewport.
- **Feedback states**: loading, empty, error and offline each shown sensibly; every action
  acknowledged.
- **Flow friction**: steps that could be fewer, dead ends, information asked for twice.
- **Copy**: wording that is unclear, inconsistent, or wrong in tone.
- **Visual consistency**: colours, spacing and type that stray from the theme tokens.

A functional bug — something that is broken rather than awkward — is not a finding. File it as a
discovery instead.

## 5. Report

Stop the app. Output numbered findings, each with:

- the screen or route;
- repro steps, including the viewport and theme;
- what feels off;
- a suggested fix.

Never commit, push, or open a pull request.

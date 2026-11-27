---
name: design-review
description: Walk a project's app in a browser on a phone and a desktop, and judge its visual design against Material 3 — hierarchy, type roles, spacing, colour roles, elevation, component choice, touch targets.
disable-model-invocation: true
---

Reviews how one project's app looks, against Material 3 (https://m3.material.io), and stops there.
How the app feels to use is `ux-review`'s, not this one's. The ticket argument is the go-ahead for
every step below. A run may be unattended, with nobody to answer a question, so each step carries
straight into the next, ending only at a stop a step names or at the report. Nothing is committed
or pushed, and no tracked file is edited.

The argument is the ticket (number or URL). Name the repo explicitly (`--repo <owner>/<repo>`)
whenever `origin` is not a GitHub remote.

## 1. Read the ticket

`gh issue view <ticket>`. Take from it the screens to walk and the scenario to seed the app with.
With no scenario named, use `owner-with-items`. Done when you hold a list of screens and one
scenario name.

## 2. Start the app

Check `package.json` for a `ux` script. With none, stop: hand back saying the project has no `ux`
script, and report nothing else.

Otherwise run `npm ci`, then `npm run ux -- --scenario <name>` in the background. Wait for the
URL it prints, and use that URL for every step below. Done when the URL answers.

## 3. Walk the screens

Drive the app with Playwright MCP, walking every screen from step 1 in this order:

1. An Android phone: 412×915 viewport, touch enabled. This pass comes first and gets the most
   attention; the app is used on a phone.
2. One desktop pass at 1280×800.

Each pass runs in the light theme and again in the dark one: emulate `prefers-color-scheme` for
each, and where the app has its own theme setting, set that to match too. Take a screenshot of
every screen in every combination, and judge from the screenshots as well as the DOM.

### Signing in through a popup

When the app signs in through the Firebase Auth emulator's Google popup, drive it as a person would,
one step at a time:

1. Click the app's own sign-in control.
2. List the tabs with `browser_tabs`, then switch to the popup's.
3. Pick the scenario's account in the emulator's chooser: the one the `ux` script's output names for
   the scenario. If it names none, take the chooser's only account; if there are several, say so in
   the report rather than guess.
4. The popup usually closes itself once an account is picked. List the tabs again and select the
   app's if it is not already the current one.

Never call `signInWithPopup`, or await anything else that waits on user interaction, inside
`browser_run_code_unsafe` or `browser_evaluate`: nobody completes the popup there, so the call never
returns and the run stalls until the sandbox kills it.

Done when every screen has been walked in all four combinations.

## 4. Judge the design against Material 3

Judge against this rubric, and nothing else. For each point, name the Material 3 rule or value it
breaks, from m3.material.io, rather than a taste:

- **Hierarchy**: whether the eye lands on the most important thing first; what competes with it.
- **Type roles**: display, headline, title, body, label — whether each piece of text uses the role
  its job calls for, and the scale's sizes, weights and line heights.
- **Spacing and density**: the 4dp grid and the layout's margins and gutters for the window size
  class (compact for the phone, expanded for the desktop); padding inside components; crowding or
  slack.
- **Colour roles and tones**: primary, secondary, tertiary, surface and their containers, with
  the matching on-colours; whether each colour is used for its role, and contrast holds in light
  and in dark. Hard-coded colours that bypass the roles.
- **Elevation and surfaces**: surface tone and container levels, shadows used only where M3
  uses them, one layer's worth of separation per step.
- **Component choice**: whether each control is the M3 component for its job (button type, chip,
  card, list item, navigation bar or rail, dialog, sheet, text field), and used as M3 specifies.
- **Touch targets**: at least 48×48dp on the phone, with the spacing between targets M3 asks for.

A judgement call that Material 3 does not settle is still a finding, but flag it as one: say that
M3 is silent and why you would still change it. Never present a taste as an M3 rule.

A functional bug — something broken rather than ugly — is not a finding. File it as a `suggestion`
discovery instead: it is work the ticket doesn't cover, and it rides alongside the findings rather
than stopping the run. How the app feels to use is not a finding here either.

## 5. Report

Stop the app. Output numbered findings, each with:

- the screen or route;
- repro steps, including the viewport and theme;
- what is off;
- the Material 3 rule or value it breaks, or "judgement call: M3 does not settle this";
- a suggested fix;
- the repo the fix belongs in: this project, or `household-ui` for a shared theme token or
  component.

Findings stay in the report. Never commit, push, open a pull request, or file a ticket for a
finding: the developer triages them.

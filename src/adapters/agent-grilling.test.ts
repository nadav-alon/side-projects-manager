import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { grillingPrompt } from "./agent-grilling.ts";

const CHECKOUT = "/projects/nadav-alon/pilot";

describe("what the grilling session is asked to do", () => {
  it("points the session at the instructions scaffolded into the checkout", () => {
    const prompt = grillingPrompt({ directory: CHECKOUT, existing: false });

    assert.match(prompt, /AGENTS\.md/);
    assert.match(prompt, /docs\/agents\//);
  });

  it("asks for a grilling that models as it goes, not a bare interview", () => {
    const prompt = grillingPrompt({ directory: CHECKOUT, existing: false });

    assert.match(prompt, /grill-with-docs/);
    assert.match(prompt, /CONTEXT\.md/);
  });

  it("asks for tickets in the project's own tracker", () => {
    const prompt = grillingPrompt({ directory: CHECKOUT, existing: false });

    assert.match(prompt, /tickets in this project's issue tracker/);
  });

  it("gives a created repo no language to go looking for", () => {
    const prompt = grillingPrompt({ directory: CHECKOUT, existing: false });

    assert.doesNotMatch(prompt, /already uses/);
  });

  it("asks a repo that predates the manager for the language it already has", () => {
    const prompt = grillingPrompt({ directory: CHECKOUT, existing: true });

    assert.match(prompt, /language it already uses/);
  });

  it("asks for a ticket to close the gap rather than renaming mid-session", () => {
    const prompt = grillingPrompt({ directory: CHECKOUT, existing: true });

    assert.match(prompt, /raise a ticket/);
    assert.match(prompt, /rather than renaming anything/);
  });

  it("carries nothing about the manager into the session", () => {
    const prompt = grillingPrompt({ directory: CHECKOUT, existing: true });

    assert.doesNotMatch(prompt, /side-projects-manager/);
  });
});

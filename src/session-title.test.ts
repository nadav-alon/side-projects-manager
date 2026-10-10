import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteUrl, repoOfRemote } from "./ports/remote-url.ts";
import { repoSlug } from "./ports/repo-slug.ts";
import { isOwnTitle, ticketOf } from "./session-title.ts";
import { withPromptHook } from "./session-title-settings.ts";

const repo = repoSlug("nadav-alon/pilot");

test("only a ticket of this repo is named", () => {
  assert.equal(ticketOf("#4", repo), 4);
  assert.equal(ticketOf("Nadav-Alon/Pilot#5", repo), 5);
  assert.equal(ticketOf("https://github.com/nadav-alon/pilot/issues/6", repo), 6);
  assert.equal(ticketOf("other/repo#7 #8", repo), 8);
  assert.equal(ticketOf("other/repo#7", repo), undefined);
  assert.equal(ticketOf("other/repo#7", undefined), undefined);
  assert.equal(ticketOf("#9", undefined), 9);
  assert.equal(ticketOf("#0", repo), undefined);
});

test("a title is ours only in the whole shape the hook produces", () => {
  assert.ok(isOwnTitle("triage: nadav-alon/pilot#7"));
  assert.ok(isOwnTitle("grill-me: tmp"));
  assert.ok(!isOwnTitle("triage: notes for Q3"));
  assert.ok(!isOwnTitle("my own name"));
});

test("a remote of any scheme names its owner/repo", () => {
  for (const url of [
    "https://github.com/nadav-alon/pilot.git",
    "git@github.com:nadav-alon/pilot.git",
    "ssh://git@github.com/nadav-alon/pilot",
  ]) {
    assert.equal(repoOfRemote(remoteUrl(url)), "nadav-alon/pilot");
  }
  assert.equal(repoOfRemote(remoteUrl("/pilot")), undefined);
});

test("the hook is merged beside others and replaced, not repeated", () => {
  const other = { hooks: [{ type: "command", command: "echo hi" }] };
  const once = withPromptHook({ model: "x", hooks: { UserPromptSubmit: [other] } }, "hook.ts", "node hook.ts");
  const twice = withPromptHook(once, "hook.ts", "node hook.ts") as {
    model: string;
    hooks: { UserPromptSubmit: unknown[] };
  };
  assert.equal(twice.model, "x");
  assert.equal(twice.hooks.UserPromptSubmit.length, 2);
  assert.deepEqual(twice.hooks.UserPromptSubmit[0], other);
});

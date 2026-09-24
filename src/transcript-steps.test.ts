import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recentSteps } from "./transcript-steps.ts";

function assistantLine(timestamp: string, content: unknown[]): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { role: "assistant", content },
  });
}

describe("recentSteps", () => {
  it("formats a tool call as an arrow, the tool's name and its primary argument", () => {
    const line = assistantLine("2026-09-24T09:00:00.000Z", [
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    ]);

    assert.deepEqual(recentSteps(line, 10), [
      { at: new Date("2026-09-24T09:00:00.000Z"), line: "→ Bash: npm test" },
    ]);
  });

  it("formats the agent's own text as one line", () => {
    const line = assistantLine("2026-09-24T09:00:00.000Z", [
      { type: "text", text: "Reading the ticket before touching anything." },
    ]);

    assert.deepEqual(recentSteps(line, 10), [
      {
        at: new Date("2026-09-24T09:00:00.000Z"),
        line: "Reading the ticket before touching anything.",
      },
    ]);
  });

  it("collapses multi-line text onto one line", () => {
    const line = assistantLine("2026-09-24T09:00:00.000Z", [
      { type: "text", text: "First line.\n\nSecond line." },
    ]);

    assert.deepEqual(recentSteps(line, 10)[0]?.line, "First line. Second line.");
  });

  it("truncates a long line, marking it with an ellipsis", () => {
    const long = "x".repeat(200);
    const line = assistantLine("2026-09-24T09:00:00.000Z", [{ type: "text", text: long }]);

    const [step] = recentSteps(line, 10);
    assert.equal(step?.line.endsWith("…"), true);
    assert.equal(step?.line.length, 101);
  });

  it("falls back to the input's own first string field when no common one is present", () => {
    const line = assistantLine("2026-09-24T09:00:00.000Z", [
      { type: "tool_use", name: "Weird", input: { odd: "field", other: 7 } },
    ]);

    assert.equal(recentSteps(line, 10)[0]?.line, "→ Weird: field");
  });

  it("keeps only the last N steps, oldest first", () => {
    const lines = ["a", "b", "c", "d"]
      .map((text, index) =>
        assistantLine(`2026-09-24T09:0${index}:00.000Z`, [{ type: "text", text }]),
      )
      .join("\n");

    assert.deepEqual(
      recentSteps(lines, 2).map((step) => step.line),
      ["c", "d"],
    );
  });

  it("skips malformed lines without aborting the parse", () => {
    const lines = [
      "not json at all",
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      assistantLine("2026-09-24T09:00:00.000Z", [{ type: "text", text: "hello" }]),
    ].join("\n");

    assert.deepEqual(
      recentSteps(lines, 10).map((step) => step.line),
      ["hello"],
    );
  });

  it("skips an assistant entry with no usable timestamp", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    assert.deepEqual(recentSteps(line, 10), []);
  });

  it("returns nothing for empty content", () => {
    assert.deepEqual(recentSteps("", 10), []);
  });
});

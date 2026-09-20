import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTranscriptPath, transcriptPath } from "./transcript-path.ts";

describe("isTranscriptPath", () => {
  it("accepts a normalised absolute path", () => {
    assert.ok(isTranscriptPath("/home/node/.claude/projects/-repo/session.jsonl"));
  });

  it("refuses a relative path, which no adapter could resolve twice", () => {
    assert.equal(isTranscriptPath("session.jsonl"), false);
    assert.equal(isTranscriptPath("./session.jsonl"), false);
    assert.equal(isTranscriptPath(""), false);
  });

  /** Two spellings of one file must not read as two transcripts. */
  it("refuses a path that is not already in join's shape", () => {
    assert.equal(isTranscriptPath("/transcripts/../session.jsonl"), false);
    assert.equal(isTranscriptPath("/transcripts//session.jsonl"), false);
    assert.equal(isTranscriptPath("/transcripts/session.jsonl/"), false);
  });
});

describe("transcriptPath", () => {
  it("narrows an absolute path", () => {
    assert.equal(
      transcriptPath("/transcripts/session.jsonl"),
      "/transcripts/session.jsonl",
    );
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => transcriptPath("session.jsonl"), /session\.jsonl/);
  });
});

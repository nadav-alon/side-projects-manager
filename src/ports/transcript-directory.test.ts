import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isTranscriptDirectory,
  transcriptDirectory,
} from "./transcript-directory.ts";

describe("isTranscriptDirectory", () => {
  it("accepts a normalised absolute path", () => {
    assert.ok(isTranscriptDirectory("/tmp/side-projects-transcript-run-abc123"));
  });

  it("refuses a relative path, which no adapter could resolve twice", () => {
    assert.equal(isTranscriptDirectory("transcripts"), false);
    assert.equal(isTranscriptDirectory("./transcripts"), false);
    assert.equal(isTranscriptDirectory(""), false);
  });

  /** Two spellings of one directory must not read as two transcript directories. */
  it("refuses a path that is not already in join's shape", () => {
    assert.equal(isTranscriptDirectory("/tmp/../transcripts"), false);
    assert.equal(isTranscriptDirectory("/tmp//transcripts"), false);
    assert.equal(isTranscriptDirectory("/tmp/transcripts/"), false);
  });
});

describe("transcriptDirectory", () => {
  it("narrows an absolute path", () => {
    assert.equal(transcriptDirectory("/tmp/transcripts"), "/tmp/transcripts");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => transcriptDirectory("transcripts"), /transcripts/);
  });
});

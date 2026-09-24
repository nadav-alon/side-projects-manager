/**
 * One line of an agent's own recent activity, read back off its session
 * transcript for `status` to show while a run is still going — CONTEXT.md's
 * "Run in progress". Already formatted: a tool call as `→ Tool: arg`, agent
 * text as one truncated line, per the transcript's own `assistant` entries.
 */
export interface TranscriptStep {
  at: Date;
  line: string;
}

/** How much of a step's own line is kept before it is truncated with `…`. */
const LINE_LIMIT = 100;

/**
 * The last `limit` steps a transcript's own JSONL content holds, oldest
 * first — every `assistant` entry's tool calls and text, in the order the
 * transcript wrote them.
 *
 * Pure and string-in, string-out, like `parseUsageWindows`: `content` is a
 * transcript already read off disk, so this stays testable on canned
 * fixtures rather than real files. A line that is not well-formed JSON, not
 * an `assistant` entry, or carries no timestamp is skipped rather than
 * aborting the read — the same tolerance `parseUsageWindows` gives a session
 * log line, for the same reason: a transcript is the agent CLI's own
 * output, not a document this owns the shape of. A line marked
 * `isSidechain: true` is skipped too: a subagent's own turn, on CLI versions
 * that write one into the main transcript, is not a step of the run itself.
 */
export function recentSteps(content: string, limit: number): TranscriptStep[] {
  const steps = content.split("\n").flatMap(parseTranscriptLine);
  return steps.slice(-limit);
}

function parseTranscriptLine(line: string): TranscriptStep[] {
  const trimmed = line.trim();
  if (trimmed === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "assistant" || record.isSidechain === true) {
    return [];
  }

  const at = parseTimestamp(record.timestamp);
  if (at === undefined) {
    return [];
  }

  const message = record.message;
  if (typeof message !== "object" || message === null) {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((block) => stepFor(block, at));
}

function stepFor(block: unknown, at: Date): TranscriptStep[] {
  if (typeof block !== "object" || block === null) {
    return [];
  }
  const item = block as Record<string, unknown>;

  if (item.type === "text" && typeof item.text === "string") {
    const text = truncate(item.text);
    return text === "" ? [] : [{ at, line: text }];
  }

  if (item.type === "tool_use" && typeof item.name === "string") {
    return [{ at, line: `→ ${item.name}: ${truncate(describeToolInput(item.input))}` }];
  }

  return [];
}

/**
 * A tool call's own primary argument, for the one-line step it becomes: the
 * first of a handful of common single-value fields a tool's input carries,
 * else the first string value the input has at all, else the input itself —
 * there being no field a tool's input is guaranteed to carry, this is a
 * best-effort summary rather than a parse of any one tool's own shape.
 */
const PRIMARY_ARG_FIELDS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

function describeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return String(input);
  }
  const record = input as Record<string, unknown>;
  for (const field of PRIMARY_ARG_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  const firstString = Object.values(record).find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return firstString ?? JSON.stringify(record);
}

/** `text`, collapsed onto one line and cut to `LINE_LIMIT`, marked with `…` when it was. */
function truncate(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= LINE_LIMIT ? singleLine : `${singleLine.slice(0, LINE_LIMIT)}…`;
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

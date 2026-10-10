/**
 * The fields of a run's `structured_output`, as `claude --json-schema`
 * hands them back — an example fixture for tests, not something any adapter
 * reads: the container adapter's own `structuredAnswerFrom` is what reads an
 * envelope shaped like this.
 */
export interface StructuredAnswerFixture {
  gist?: string;
  nits?: string;
  gaveUp?: boolean;
  reason?: string;
}

/**
 * The envelope `claude --print … --output-format json --json-schema <schema>`
 * writes to stdout once a run answers: a `result` meant to be read and the
 * validated answer under `structured_output`. `gaveUp` defaults to false, the
 * one field the schema requires.
 */
export function structuredStdout(
  result: string,
  answer: StructuredAnswerFixture = {},
): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    structured_output: { gaveUp: false, ...answer },
    permission_denials: [],
  });
}

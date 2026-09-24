const GLOSSARY_HEADING = "## Language";

/** The column width CONTEXT.md's glossary is hard-wrapped to, file-wide (#700). */
export const GLOSSARY_WRAP_WIDTH = 100;

/**
 * 1-indexed line numbers, within CONTEXT.md's glossary (from `## Language` to
 * end of file), wider than GLOSSARY_WRAP_WIDTH. Empty once the glossary is
 * fully wrapped.
 */
export function unwrappedGlossaryLines(contextMd: string): number[] {
  const lines = contextMd.split("\n");
  const glossaryStart = lines.indexOf(GLOSSARY_HEADING);
  if (glossaryStart === -1) {
    throw new Error(`CONTEXT.md has no "${GLOSSARY_HEADING}" heading to find the glossary under.`);
  }

  const violations: number[] = [];
  for (let index = glossaryStart + 1; index < lines.length; index++) {
    if ((lines[index] ?? "").length > GLOSSARY_WRAP_WIDTH) {
      violations.push(index + 1);
    }
  }
  return violations;
}

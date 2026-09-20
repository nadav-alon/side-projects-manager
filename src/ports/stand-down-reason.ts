/** Which window refused a run, and whether consumption alone did it or the estimate tipped it over. */
export type StandDownReason =
  /** The week alone, before any estimate, had already eaten into the developer's reserve. */
  | "weekly-reserve"
  /** The week was within its reserve, but the estimate charged would eat into it. */
  | "weekly-reserve-estimate"
  /** The current 5-hour block was already spent, whatever the week looks like. */
  | "five-hour-window"
  /** The block was within its spendable, but the estimate charged would spend it. */
  | "five-hour-window-estimate";

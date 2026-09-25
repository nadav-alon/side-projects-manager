import type {
  Budget,
  Clock,
  ProjectState,
  RepoSlug,
  ReserveFraction,
  RunCost,
  Size,
  StandDownReason,
  Store,
  Ticket,
  TokenCount,
  UsageLedger,
  UsageWindow,
  UsageWindows,
  Usd,
} from "./ports/index.ts";
import { declaredSize, spendCeilingFor, tokenCount } from "./ports/index.ts";


/** Why the loop stood down, and everything the developer needs to see why. */
export interface StandDown {
  reason: StandDownReason;
  /** What that window had consumed when the gate looked, estimate not included. */
  tokensUsed: TokenCount;
  /** The most it may consume before the gate refuses. */
  spendable: TokenCount;
  /** When that window resets, which is when work could resume. */
  resetsAt: Date;
  /**
   * The run estimate charged against this window: the ticket about to start's
   * own estimate, plus every ticket still in progress's. What, together with
   * `tokensUsed`, decided `reason`.
   */
  estimateCharged: TokenCount;
}

/** What a consultation found: its verdict, and the budget document it read to reach it. */
export interface Consultation {
  /** `undefined` is the go-ahead. */
  standDown: StandDown | undefined;
  /**
   * The document this consultation read. Handed back rather than reread, so
   * the loop's own concerns that live in it — the concurrency limit, the
   * spend ceiling — see exactly what the verdict was reasoned over.
   */
  budget: Budget;
  /**
   * The run estimate `ticket` itself charged, not counting `inProgress`.
   * Carried on a go-ahead too, since `standDown` is `undefined` there and has
   * nothing to carry it on. Recorded on the iteration outcome by the loop,
   * beside what the run went on to spend.
   */
  estimateCharged: TokenCount;
}

/** The two ports the gate reads afresh on every consultation. */
export interface BudgetGatePorts {
  ledger: UsageLedger;
  clock: Clock;
  store: Pick<Store, "loadBudget">;
}

/**
 * The invocation's whole view of the budget gate: one question, asked before
 * every run, over whatever the ledger and the state document say at that
 * instant.
 *
 * A single instance is built once per invocation and lives for its whole
 * length, the same as `InvocationSelection` — not because it caches
 * anything, but because it is what the loop hands each iteration instead of
 * assembling the consultation itself.
 */
export interface InvocationBudgetGate {
  /**
   * Whether `ticket`'s run may start, given the tickets whose runs are still
   * in progress.
   *
   * Reads the budget document afresh and the ledger at this instant, with
   * the budget document's own observed reset, and counts the runs the state
   * document records inside each window — nothing here is cached from when
   * the gate was built. Charges a run estimate for `ticket` and for every
   * ticket in `inProgress`, resolved from each one's own size label — see
   * `budgetGate`.
   */
  consult(
    ticket: Ticket,
    inProgress: readonly Ticket[],
  ): Promise<Consultation>;
}

/**
 * Builds one invocation's budget gate, over `projectStates` as the
 * invocation holds it. Read live rather than copied: it is the same map
 * `morningLoop` records a finished run's cost into, so a run recorded
 * between two consultations is exactly what the next one counts.
 */
export function invocationBudgetGate(
  ports: BudgetGatePorts,
  projectStates: ReadonlyMap<RepoSlug, ProjectState>,
): InvocationBudgetGate {
  return {
    consult: async (ticket, inProgress) => {
      const budget = await ports.store.loadBudget();
      const windows = await ports.ledger.read(
        ports.clock.now(),
        budget.observedResetAt,
      );
      return {
        standDown: budgetGate(
          windows,
          budget,
          runsRecorded(projectStates),
          ticket,
          inProgress,
        ),
        budget,
        estimateCharged: runEstimate(ticket, budget),
      };
    },
  };
}

/** Every run the mornings have made, across every project, oldest first. */
export function runsRecorded(
  projectStates: ReadonlyMap<RepoSlug, ProjectState>,
): RunCost[] {
  return [...projectStates.values()]
    .flatMap((project) => project.runs)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Whether a run may start, given the windows in force, what the mornings have
 * already spent, what the developer declared they are willing to spend, and
 * the ticket about to start and the tickets still in progress. `undefined` is
 * the go-ahead.
 *
 * The window arithmetic `invocationBudgetGate` calls this with: pure, and
 * the gate's own internal seam — everything above assembles what this needs
 * from the outside world; this is only ever asked to add it up.
 *
 * Two windows, refusing for two different reasons. The weekly window is
 * measured against the part of the allowance the reserve does not hold back,
 * so the developer's own interactive work still has a week's worth of room
 * after the mornings have had theirs. The 5-hour window has its own reserve
 * too, `fiveHourReserveFraction`, which a machine that declares none leaves
 * at zero — measuring the block against its whole allowance, because a spent
 * block is a wall the loop should not walk into rather than a supply to
 * ration.
 *
 * Each window counts what it has consumed, plus the run estimate for the
 * ticket about to start and for every ticket still in progress (ADR 0004),
 * which is what stops a run authorised at the boundary from spending its
 * whole spend ceiling out of the reserve, and a run in progress from
 * overshooting unaccounted for (ADR 0004, which supersedes ADR 0003). A window
 * whose consumption alone already exceeds what is spendable refuses for that
 * reason alone; one within it that the estimate would push over refuses for
 * the estimate instead — told apart so the developer knows which is true.
 * Reaching the boundary exactly, consumption and estimate together, is still
 * a go.
 *
 * When both windows refuse, the developer hears about whichever resets later:
 * that is when work could actually resume, and a trigger that came back at the
 * earlier instant would only stand down again.
 *
 * `ownSpend` is required rather than defaulting to none: a gate that counted
 * no runs is not a cautious gate, it is the under-counting one the state
 * document exists to fix, and a caller that forgot to pass it should not
 * compile.
 *
 * Every number here is an inference. What the provider does report of a
 * window's own usage never reaches a headless run, and the ledger cannot see
 * the developer's usage from Claude chat or another machine, so the windows
 * read low. The reserve is what absorbs that, and it is why the arithmetic
 * rounds the developer's way throughout: a reserve that does not divide
 * evenly is held back whole.
 */
export function budgetGate(
  windows: UsageWindows,
  budget: Budget,
  ownSpend: readonly RunCost[],
  ticket: Ticket,
  inProgress: readonly Ticket[],
): StandDown | undefined {
  const estimateCharged = totalEstimate(ticket, inProgress, budget);
  const configs = windowConfigs(windows, budget);
  const weekly = refusal(
    { spent: "weekly-reserve", estimate: "weekly-reserve-estimate" },
    configs.weekly,
    ownSpend,
    estimateCharged,
  );
  const fiveHour = refusal(
    { spent: "five-hour-window", estimate: "five-hour-window-estimate" },
    configs.fiveHour,
    ownSpend,
    estimateCharged,
  );

  if (weekly !== undefined && fiveHour !== undefined) {
    return fiveHour.resetsAt > weekly.resetsAt ? fiveHour : weekly;
  }
  return weekly ?? fiveHour;
}

/**
 * One window paired with the allowance and reserve fraction it is measured
 * against. The pairing itself — weekly with `reserveFraction`, the 5-hour
 * window with `fiveHourReserveFraction` — is made once, here, so `budgetGate`
 * and `budgetStatus` cannot each pair a window with the wrong reserve and
 * quietly disagree about which one applies.
 */
interface WindowConfig {
  window: UsageWindow;
  allowance: TokenCount;
  reserveFraction: ReserveFraction;
}

function windowConfigs(
  windows: UsageWindows,
  budget: Budget,
): { weekly: WindowConfig; fiveHour: WindowConfig } {
  return {
    weekly: {
      window: windows.weekly,
      allowance: budget.weeklyAllowance,
      reserveFraction: budget.reserveFraction,
    },
    fiveHour: {
      window: windows.fiveHour,
      allowance: budget.fiveHourAllowance,
      reserveFraction: budget.fiveHourReserveFraction,
    },
  };
}

/**
 * Whether `tokensUsed` alone already exceeds `spendable` — the reserve
 * reached, before any run estimate is charged. Shared by `refusal`, which
 * charges an estimate on top, and `windowStatus`, which does not, so the two
 * cannot drift apart on what "reached" means.
 */
function windowSpent(tokensUsed: TokenCount, spendable: TokenCount): boolean {
  return tokensUsed > spendable;
}

/**
 * The stand-down `config`'s window calls for, or `undefined` when it still
 * has room for both what it has consumed and `estimateCharged` besides.
 *
 * A window whose consumption alone exceeds what is spendable refuses under
 * `reasons.spent`, whatever the estimate is. One within it that
 * `estimateCharged` would push over refuses under `reasons.estimate` instead
 * — the two are told apart so the developer knows whether a spent window or
 * an estimate is what stopped the run. A window that, consumption and
 * estimate together, lands exactly on what is spendable has not overrun it,
 * so the boundary is a go.
 */
function refusal(
  reasons: { spent: StandDownReason; estimate: StandDownReason },
  config: WindowConfig,
  ownSpend: readonly RunCost[],
  estimateCharged: TokenCount,
): StandDown | undefined {
  const spendable = spendableOf(config.allowance, config.reserveFraction);
  const tokensUsed = consumedIn(config.window, ownSpend);
  if (windowSpent(tokensUsed, spendable)) {
    return {
      reason: reasons.spent,
      tokensUsed,
      spendable,
      resetsAt: config.window.resetsAt,
      estimateCharged,
    };
  }
  if (tokensUsed + estimateCharged > spendable) {
    return {
      reason: reasons.estimate,
      tokensUsed,
      spendable,
      resetsAt: config.window.resetsAt,
      estimateCharged,
    };
  }
  return undefined;
}

/**
 * The run estimate `ticket` and every ticket in `inProgress` together charge
 * against a window: the same total for both windows, since the estimate
 * itself does not vary by window.
 */
function totalEstimate(
  ticket: Ticket,
  inProgress: readonly Ticket[],
  budget: Budget,
): TokenCount {
  return tokenCount(
    [ticket, ...inProgress].reduce(
      (total, candidate) => total + runEstimate(candidate, budget),
      0,
    ),
  );
}

/**
 * The size `ticket` counts as, per `CONTEXT.md`'s "Run estimate": `ticket`'s
 * own declared size (`declaredSize`), or `unsizedCountsAs` where it names
 * none.
 *
 * What `runEstimate` charges in tokens and `spendCeilingForTicket` bounds in
 * dollars are the same size, resolved once here for both.
 */
function sizeFor(ticket: Ticket, budget: Budget): Size {
  return declaredSize(ticket) ?? budget.unsizedCountsAs;
}

/**
 * The run estimate `ticket` charges, in the tokens `budget.sizes` gives its
 * size. Never derived from what past runs cost.
 *
 * A ticket whose size label names no size the budget document knows never
 * reaches here: the loop hands it back ahead of the gate instead.
 */
function runEstimate(ticket: Ticket, budget: Budget): TokenCount {
  return budget.sizes[sizeFor(ticket, budget)];
}

/**
 * The dollar ceiling `ticket`'s run may spend, per `budget.spendCeiling` for
 * the same size `runEstimate` charges it as. What reaches the sandbox as
 * `--max-budget-usd`.
 */
export function spendCeilingForTicket(ticket: Ticket, budget: Budget): Usd {
  return spendCeilingFor(sizeFor(ticket, budget), budget.spendCeiling);
}

/**
 * Everything `window` has consumed: what the ledger can see, plus what the
 * mornings spent inside it.
 *
 * The two are added rather than one being trusted, because the ledger cannot
 * see a run at all. It reads this machine's session logs, and a run writes its
 * log inside a container that is thrown away when it ends — so a morning that
 * spent the week leaves the ledger reporting the same total it reported
 * before. A gate that read only the ledger would ration the developer's own
 * typing and never the thing it exists to bound.
 *
 * This holds only while runs are invisible to the ledger. If the sandbox ever
 * keeps its logs where the ledger reads them, the sum below starts counting
 * every run twice, and this is the place that has to know.
 */
function consumedIn(
  window: UsageWindow,
  ownSpend: readonly RunCost[],
): TokenCount {
  return spendIn(window, ownSpend).tokensUsed;
}

/**
 * What `window` has consumed, split by who spent it: the mornings' own runs
 * the state document records (`loopSpent`), and everything else the ledger
 * reports (`developerSpent`) — see `consumedIn` for why both are counted.
 * `statusReport` prints this same split; `budgetStatus` is where it is drawn
 * from, so a change to this arithmetic changes what both the gate and the
 * status command see.
 */
function spendIn(
  window: UsageWindow,
  ownSpend: readonly RunCost[],
): { tokensUsed: TokenCount; loopSpent: TokenCount; developerSpent: TokenCount } {
  const loopSpent = tokenCount(
    ownSpend
      .filter((run) => run.at.getTime() >= window.openedAt.getTime())
      .reduce((total, run) => total + run.tokensUsed, 0),
  );
  return {
    tokensUsed: tokenCount(window.tokensUsed + loopSpent),
    loopSpent,
    developerSpent: window.tokensUsed,
  };
}

/**
 * One window's spend against its budget, as `status` reports it: everything
 * `refusal` charges consumption with, laid out for reading rather than
 * reduced to a verdict. `reserveReached` is `refusal`'s own "spent" branch —
 * no run estimate charged, since a status report describes no run about to
 * start.
 */
export interface WindowStatus {
  /** Consumed altogether: the ledger's own view plus what the mornings spent. */
  tokensUsed: TokenCount;
  /** `tokensUsed`'s share the mornings spent, per the state document. */
  loopSpent: TokenCount;
  /** `tokensUsed`'s share the ledger attributes to the developer's own use. */
  developerSpent: TokenCount;
  /** The window's declared allowance, reserve included. */
  allowance: TokenCount;
  /** What the window may spend before its reserve is reached. */
  spendable: TokenCount;
  /** When the window resets. */
  resetsAt: Date;
  /** Whether `tokensUsed` already exceeds `spendable` — the gate would refuse a run now, before any estimate is even charged. */
  reserveReached: boolean;
}

/** Both windows' status, as `budgetStatus` reports them. */
export interface BudgetStatus {
  fiveHour: WindowStatus;
  weekly: WindowStatus;
}

/**
 * `windows` and `ownSpend` laid out the way the gate itself reasons over
 * them, one `WindowStatus` per window — the read-only counterpart to
 * `budgetGate`, for a caller that wants to show the arithmetic rather than
 * ask it a yes/no question.
 */
export function budgetStatus(
  windows: UsageWindows,
  budget: Budget,
  ownSpend: readonly RunCost[],
): BudgetStatus {
  const configs = windowConfigs(windows, budget);
  return {
    fiveHour: windowStatus(configs.fiveHour, ownSpend),
    weekly: windowStatus(configs.weekly, ownSpend),
  };
}

function windowStatus(
  config: WindowConfig,
  ownSpend: readonly RunCost[],
): WindowStatus {
  const { tokensUsed, loopSpent, developerSpent } = spendIn(config.window, ownSpend);
  const spendable = spendableOf(config.allowance, config.reserveFraction);
  return {
    tokensUsed,
    loopSpent,
    developerSpent,
    allowance: config.allowance,
    spendable,
    resetsAt: config.window.resetsAt,
    reserveReached: windowSpent(tokensUsed, spendable),
  };
}

/**
 * What is left of `allowance` once the reserve is held back.
 *
 * The reserve is taken out and rounded up, rather than the remainder being
 * computed as `allowance * (1 - reserveFraction)`. The two agree in arithmetic
 * and not in floating point, and the second form is not a token count: a
 * reserve of 0.5 against a 1,001-token week leaves 500.5, and 0.7 against
 * 1,000 leaves 300.00000000000006, so `tokenCount` below would throw on the
 * first and the gate would hand back a fractional spendable on the second.
 * Rounding the reserve up settles both the same way — a reserve that does not
 * divide evenly is held back whole, because a reserve that quietly shrinks is
 * the one mistake the gate may not make.
 */
function spendableOf(
  allowance: TokenCount,
  reserveFraction: ReserveFraction,
): TokenCount {
  return tokenCount(allowance - Math.ceil(allowance * reserveFraction));
}

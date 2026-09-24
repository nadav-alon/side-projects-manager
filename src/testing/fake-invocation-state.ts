import {
  invocationState,
  type CurrentInvocation,
  type ForeignStateFields,
  type InvocationState,
  type InvocationStatePorts,
} from "../invocation-state.ts";
import type { Day, State, WorkedTicket } from "../ports/index.ts";

/** An invocation's own in-memory recorder — see `fakeInvocationState`. */
type Recorder = (ticket: WorkedTicket, day: Day) => void;

/**
 * Builds an invocation exactly as `invocationState` does, alongside a way to
 * record a ticket worked in memory only, carrying none of `ticketSelected`'s
 * own save-at-once guarantee. For a test that needs to seed a worked-today
 * record against this same live invocation mid-selection, where
 * `FakeStore.markWorkedOn`, which seeds the stored document before the
 * invocation opens, does not reach.
 */
export function fakeInvocationState(
  ports: InvocationStatePorts,
  stored: State,
  today: Day,
  foreignFields: () => ForeignStateFields = () => ({}),
  current?: CurrentInvocation,
): { invocation: InvocationState; recordWorked: Recorder } {
  let recordWorked: Recorder | undefined;
  const invocation = invocationState(ports, stored, today, foreignFields, current, (record) => {
    recordWorked = record;
  });
  if (recordWorked === undefined) {
    throw new Error("fakeInvocationState: invocationState did not expose its recorder");
  }
  return { invocation, recordWorked };
}

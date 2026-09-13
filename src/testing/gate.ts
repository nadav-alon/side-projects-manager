/** For a test that would hang, rather than fail, if a gate were never opened or a lock never let go. */
export const HANGS = { timeout: 30_000 };

/** A promise, and the function that settles it. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

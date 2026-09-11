import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fresh temporary directory, named `<prefix>-XXXXXX`, for one test. */
export async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `${prefix}-`));
}

/**
 * The directory in a project's repo that declares its own toolchain: its
 * image's `RUN` steps execute on the host, so a diff touching it is never
 * merged by the manager.
 */
export const SANDBOX_DIRECTORY = ".sandbox";

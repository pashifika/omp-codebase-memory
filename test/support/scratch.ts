import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Host } from "../../src/paths.ts";

/**
 * A throwaway `HOME` and `PATH`, so a test can run the real lifecycle and then
 * assert what was *not* written.
 *
 * Every path in this package derives from an explicit {@link Host} rather than
 * from `os.homedir()` and `process.env`, which is what makes this possible --
 * and what makes "no code path writes to `~/.local/bin`" a checkable claim
 * instead of a code-reading exercise.
 */
export interface Scratch {
  /** The temporary root holding everything this scratch owns. */
  readonly root: string;
  /** The fake home directory. */
  readonly home: string;
  /** The only directory on the scratch `PATH`. */
  readonly pathDir: string;
  /** The host every call under test is given. */
  readonly host: Host;
}

/**
 * The system directories acquisition's own prerequisites live in: `tar`
 * everywhere, plus `xattr` and `codesign` on macOS.
 *
 * Kept out of the default `PATH` so a resolution test cannot be decided by a
 * real `codebase-memory-mcp` installation on the machine running the suite.
 * A test that needs the tools asks for them, and says so by asking.
 */
const SYSTEM_TOOL_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export interface ScratchOptions {
  /** Appends {@link SYSTEM_TOOL_PATH} to the scratch `PATH`. */
  readonly systemTools?: boolean;
  /** Extra environment variables, e.g. `OMP_PROFILE`. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Creates a scratch host.
 *
 * `PATH` names exactly one empty directory unless a test opts into the system
 * tool directories. Inheriting the developer's own `PATH` would let a real
 * `codebase-memory-mcp` installation decide the outcome of a resolution test.
 */
export async function makeScratch(options: ScratchOptions = {}): Promise<Scratch> {
  const root = await mkdtemp(path.join(tmpdir(), "cbm-scratch-"));
  const home = path.join(root, "home");
  const pathDir = path.join(root, "path-bin");
  await mkdir(home, { recursive: true });
  await mkdir(pathDir, { recursive: true });

  const searchPath = [pathDir, ...(options.systemTools === true ? SYSTEM_TOOL_PATH : [])];
  return {
    root,
    home,
    pathDir,
    host: { home, env: { HOME: home, PATH: searchPath.join(":"), ...options.env } },
  };
}

/** Removes a scratch root. */
export async function dropScratch(scratch: Scratch): Promise<void> {
  await rm(scratch.root, { recursive: true, force: true });
}

/**
 * Writes an executable shell script at `file`, creating its parent.
 *
 * Stands in for the real binary wherever a test only needs something that runs
 * and prints a version -- resolution ordering, the smoke check, adoption.
 */
export async function writeFakeExecutable(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

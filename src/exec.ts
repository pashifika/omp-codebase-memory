/**
 * The one place this package starts a subprocess.
 *
 * Acquisition needs `tar`, macOS repair needs `xattr` and `codesign`, and
 * resolution needs the candidate's own `--version`. All four go through
 * {@link run}, so the timeout, the output capture, and the "is this tool even
 * installed" question have one answer rather than four.
 */

/** Default per-process deadline. Nothing here should take longer. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the process could not be started at all, e.g. a missing tool. */
  readonly spawnError?: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

/**
 * Runs `argv` and captures its output.
 *
 * Never throws for a non-zero exit or a missing executable: both are ordinary
 * outcomes here -- a candidate that will not run, a host without `xattr` -- and
 * each caller reports them differently. A thrown spawn failure is folded into
 * the result as {@link RunResult.spawnError} so the distinction survives.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  try {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: "",
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The version string an executable reports, or `null` when it will not run.
 *
 * `null` rather than a throw because every caller treats "will not run" as a
 * fact about the executable rather than an error in this package: resolution
 * reports it, acquisition refuses to adopt over it.
 */
export async function readVersion(executable: string): Promise<string | null> {
  const result = await run([executable, "--version"], { timeoutMs: 10_000 });
  if (!result.ok) return null;
  const reported = `${result.stdout}${result.stderr}`.trim();
  return reported === "" ? null : reported.split("\n")[0]?.trim() ?? null;
}

/**
 * Whether `tool` exists on `PATH`.
 *
 * Used to turn a missing prerequisite into a named refusal before a command is
 * attempted, rather than a spawn error the operator has to decode.
 */
export function haveTool(tool: string, pathEnv: string | undefined): boolean {
  return Bun.which(tool, pathEnv === undefined ? {} : { PATH: pathEnv }) !== null;
}

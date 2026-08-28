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

/**
 * Per-stream capture cap.
 *
 * `timeout` bounds how long a child runs, not how much it writes, and both
 * pipes are read into this process's memory. The bound has to clear the largest
 * output any real invocation produces, and those are tiny: a `tar -tzf` listing
 * of a release archive is four names, `--version` is one line, and `codesign`'s
 * complaints are a sentence. A quarter of a megabyte is three orders of
 * magnitude of headroom over all of them, and small enough that an over-cap
 * stream is still quotable in the refusal it causes.
 */
export const OUTPUT_LIMIT_BYTES = 262_144;

export interface RunResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set when the result is not the process's own answer: it could not be
   * started at all (a missing tool), it wrote past
   * {@link OUTPUT_LIMIT_BYTES}, or it did not finish inside its deadline.
   * In every case the captured output is a fragment and must not be parsed.
   */
  readonly spawnError?: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

/** One captured pipe: its text, and whether the cap cut it short. */
interface Captured {
  readonly text: string;
  readonly overflowed: boolean;
}

/** A pipe being drained, and the handle that stops the drain. */
interface Pipe {
  /** Settles when the pipe closes, the cap is reached, or `release` is called. */
  readonly captured: Promise<Captured>;
  /**
   * Cancels the reader, which settles a pending `read()` as `done` and so
   * settles {@link Pipe.captured} with whatever had arrived. Needed because a
   * pipe is closed by its *last* writer: a descendant that inherited it holds
   * the read open after the child this code spawned is gone, so the read has
   * to be abandonable rather than merely awaited.
   */
  release(): void;
}

/**
 * Starts draining one pipe, capped at {@link OUTPUT_LIMIT_BYTES}.
 *
 * Read chunk by chunk rather than through `new Response(stream).text()`, which
 * allocates the whole stream before anything can weigh it. The last chunk is
 * clipped to the cap rather than kept whole, so the retained fragment is
 * exactly bounded by the constant the refusal names.
 *
 * The reader never leaves this function: `child.stdout`'s reader type differs
 * between the platform and `node:stream/web` declarations, and inference is
 * what keeps that difference from having to be named.
 */
function capture(stream: ReadableStream<Uint8Array> | undefined, onOverflow: () => void): Pipe {
  if (stream === undefined) {
    return { captured: Promise.resolve({ text: "", overflowed: false }), release: () => {} };
  }

  const reader = stream.getReader();
  const drain = async (): Promise<Captured> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let overflowed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = OUTPUT_LIMIT_BYTES - total;
        // `>` rather than `>=`: a stream whose total lands exactly on the cap
        // has not overflowed, and the next read settles which it was.
        if (value.byteLength > room) {
          chunks.push(value.subarray(0, room));
          total = OUTPUT_LIMIT_BYTES;
          overflowed = true;
          onOverflow();
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes), overflowed };
  };

  return {
    captured: drain(),
    release: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

/**
 * Whether `deadline` fired before `work` settled.
 *
 * `work` is handed back to the caller rather than discarded, so the caller can
 * release the readers and then await the same promise: a `Promise.race` against
 * a rejecting timer would abandon it still pending.
 *
 * Built on {@link AbortSignal.timeout} rather than `setTimeout`, for the reason
 * `src/scheduler.ts` gives: a raw timer callback that throws escapes handler
 * dispatch and takes the session with it. There is no callback here, and
 * `src/release.ts` already bounds a request the same way.
 */
async function deadlineWon(work: Promise<unknown>, deadline: AbortSignal): Promise<boolean> {
  if (deadline.aborted) return true;
  const expired = new Promise<true>((resolve) => {
    deadline.addEventListener("abort", () => resolve(true), { once: true });
  });
  return await Promise.race([work.then(() => false), expired]);
}

/**
 * Runs `argv` and captures its output.
 *
 * Never throws for a non-zero exit or a missing executable: both are ordinary
 * outcomes here -- a candidate that will not run, a host without `xattr` -- and
 * each caller reports them differently. A thrown spawn failure is folded into
 * the result as {@link RunResult.spawnError} so the distinction survives, and
 * so are the two bounds: {@link OUTPUT_LIMIT_BYTES} and the deadline.
 *
 * The deadline is authoritative rather than advisory. Draining both pipes
 * before observing `child.exited` made it advisory, because a pipe closes when
 * its *last* writer does: `sh -c "(sleep 2) & printf ok"` returns its direct
 * child immediately and leaves a descendant holding the read, and the read was
 * awaited unconditionally. Measured before the fix: 2014 ms against a 100 ms
 * timeout, reported as a success.
 *
 * So the deadline does two things rather than one. It reaps the child's process
 * group, which is where an ordinary descendant is, *and* it releases the
 * readers. Both are needed: a descendant that starts its own session -- a
 * double fork, or another `detached` spawn -- leaves that group and survives
 * the reap while still holding the pipe, and there is no portable way to find
 * it. Releasing the readers is what makes the bound hold anyway, rather than
 * pretending such a descendant is gone.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const name = argv[0] ?? "the process";
  try {
    // One deadline object, not two: `Bun.spawn` kills the direct child when the
    // signal fires, and the same signal is what stops this side waiting on a
    // read nothing in the child controls any more.
    const deadline = AbortSignal.timeout(timeoutMs);
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: deadline,
      // `setsid`, so the child leads its own process group and the descendants
      // that inherited its pipes can be reaped with it. Without this the
      // backgrounded `sleep` above survives every signal reachable from
      // `child`.
      detached: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    /**
     * Signals the child's whole process group, then the child itself.
     *
     * The deadline path passes SIGKILL, which is why `Bun.spawn` keeps its
     * default `killSignal` of SIGTERM rather than being given one: a child
     * doing `trap '' TERM` outlives Bun's own kill and is ended here instead.
     * Measured both ways -- that child comes back with exit 137, and adding
     * `killSignal: "SIGKILL"` changes nothing any test can see, while
     * downgrading this call to SIGTERM makes it survive its deadline.
     */
    const reap = (signal: NodeJS.Signals): void => {
      try {
        // Negative pid: the group, which `detached` made this child's own and
        // which is therefore the only group this can reach.
        process.kill(-child.pid, signal);
      } catch {
        // ESRCH -- the group is already empty, which is the desired state.
      }
      child.kill(signal);
    };

    // Killed on overflow rather than merely left unread: a child whose pipe has
    // stopped being drained blocks on its next write, so the cap has to end the
    // process, not just the reading of it.
    const stopFlood = (): void => {
      reap("SIGTERM");
    };
    const stdout = capture(child.stdout, stopFlood);
    const stderr = capture(child.stderr, stopFlood);
    const drained = Promise.all([stdout.captured, stderr.captured]);

    // Both halves, because either one alone leaves a hole. Racing only the
    // drain lets a child that hands its pipes back and keeps running set its
    // own duration -- `exec 1>/dev/null 2>/dev/null; trap '' TERM; sleep 2`
    // settled the reads at once and then took 2012 ms, reported as a success.
    // Racing only the exit lets a descendant that inherited a pipe hold the
    // read open after the child is gone.
    const overran = await deadlineWon(Promise.all([drained, child.exited]), deadline);
    if (overran) {
      reap("SIGKILL");
      stdout.release();
      stderr.release();
    }
    const [out, err] = await drained;
    const exitCode = await child.exited;

    if (overran) {
      return {
        ok: false,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        spawnError: `${name} did not finish within ${timeoutMs}ms and was killed`,
      };
    }
    if (out.overflowed || err.overflowed) {
      const flooded = out.overflowed ? "stdout" : "stderr";
      return {
        ok: false,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        spawnError: `${name} wrote more than ${OUTPUT_LIMIT_BYTES} bytes to ${flooded} and was killed`,
      };
    }
    return { ok: exitCode === 0, exitCode, stdout: out.text, stderr: err.text };
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

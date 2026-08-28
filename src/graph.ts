import { OUTPUT_LIMIT_BYTES } from "./exec.ts";

/**
 * One stdio MCP session against the resolved CBM executable, held for the
 * session that opened it.
 *
 * This is the second process-spawning path in the package, and it exists
 * because the first one cannot answer in time. Measured against v0.10.8: any
 * `cli` subcommand costs a fixed ~2.86 s before it writes its first byte --
 * identical on the refusal path that does no work at all, and unchanged between
 * two back-to-back invocations, so it is process startup in a 282 MB binary
 * rather than query cost. The same binary answers `tools/call` in 14 ms once its
 * stdio server has initialized. A per-call subprocess bounded by a deadline in
 * the low hundreds of milliseconds would therefore never produce an answer; one
 * long-lived session pays the startup once and every query afterwards clears the
 * deadline by two orders of magnitude.
 *
 * Three deliberate differences from `exec.run()`, which this cannot reuse:
 *
 * - The child is not `detached` and its process group is never signalled. CBM's
 *   shared daemon is a descendant of whichever client started it, and it is the
 *   process holding the graph every other client on the account is using.
 *   Reaping a group here could take it down.
 * - `stdin` is a pipe, because the whole point is a request/response
 *   conversation rather than one invocation's captured output.
 * - No environment is overridden, in particular no cache root. CBM resolves one
 *   canonical per-account root and refuses a command configured against a
 *   different one while a session is active, observed as `CBM could not start
 *   because the active account daemon uses a different cache directory`. The
 *   root the daemon already uses is also the only one holding the index the
 *   session's own MCP connection built.
 *
 * Every response is read by narrowing the field actually used. Nothing here
 * asserts a shape onto subprocess output, so a changed upstream response
 * degrades to "no answer" instead of a confident wrong one.
 */

/**
 * How long the handshake may take, absent a caller's own budget.
 *
 * Generous because it is paid once and off any blocking path -- but only the
 * augmentation is off one. A caller with an operator waiting must not charge 20 s
 * to a handshake, and bounding that is what {@link GraphClientOptions.totalTimeoutMs}
 * is for; this stays the ceiling on the path where nothing waits.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * How long one query may take.
 *
 * Low hundreds of milliseconds, because this is paid on every search in every
 * session including subagents. A warm session answers in ~14 ms, so this bounds
 * a stall rather than the ordinary case.
 */
export const QUERY_TIMEOUT_MS = 300;

/**
 * How long a whole graph conversation may take when an operator typed the
 * command that made it.
 *
 * Two orders of magnitude above {@link QUERY_TIMEOUT_MS}, and that is the
 * point: the short bound exists so a handshake is never charged to a *tool
 * result*, and nobody is waiting on a tool result. An operator who typed
 * `/cbm status` is waiting for an answer, and that command already accepts a
 * subprocess of its own -- `readVersion` gives the same 10 s to `--version`.
 *
 * It is the budget for everything the command asks, not for each request, and
 * that distinction is the whole of the fix for a twenty-second freeze. Charged
 * per request it bounded only the last one: `/cbm status` reaches the graph
 * through `toolNames()`, whose `initialize` and `tools/list` were each charged
 * {@link HANDSHAKE_TIMEOUT_MS}, so a wedged daemon cost 20 s before the query
 * this bound governs was even sent -- measured 20,003 ms against a fake server
 * that accepts stdio and never answers `initialize`, and 20,192 ms against one
 * that hand shakes and then stalls `tools/list`. Splitting it per step
 * cannot fix that either: three sequential steps at 10 s each is 30 s, worse
 * than the bug. One wall-clock budget for the conversation is what makes the
 * command's worst case a number rather than a sum, and 10 s is the number
 * because it covers the measured ~9 s a cold CBM daemon takes to hand shake.
 */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * How many times one client may reopen a session that had already handshaken.
 *
 * Small on purpose. One transient stall deserves a retry; a server that dies
 * three times is sick, and respawning it per query would spend a 2.9 s
 * handshake each time to learn the same thing.
 */
const REOPEN_LIMIT = 2;

/** The MCP protocol revision this client speaks. */
const PROTOCOL_VERSION = "2024-11-05";

/**
 * The deadline's own resolution value.
 *
 * A symbol rather than `null`, so a response that legitimately carries a null
 * result cannot be mistaken for a timeout.
 */
const EXPIRED = Symbol("deadline");

export interface GraphClient {
  /**
   * One tool's `structuredContent`, or `null` on any failure.
   *
   * Never throws and never reports: every caller treats a missing answer as
   * "append nothing", and a graph query that failed is not something an
   * operator asked for and must not be told about per call.
   */
  call(tool: string, args: Readonly<Record<string, unknown>>): Promise<unknown | null>;
  /** The server's tool names, or `null` when the list could not be obtained. */
  toolNames(): Promise<readonly string[] | null>;
  /** Ends the session. Safe to call more than once, and after a failure. */
  close(): void;
}

export interface GraphClientOptions {
  /** Per-query deadline. Defaults to {@link QUERY_TIMEOUT_MS}. */
  readonly queryTimeoutMs?: number;
  /**
   * A wall-clock budget for everything this client is asked, handshake included.
   * Unset means each request is bounded on its own, which is the augmentation's
   * shape: a query refuses to wait for a handshake, so there is no conversation
   * to bound.
   *
   * Set by a caller with an operator waiting, where the sum of the per-request
   * bounds is the wrong number. `/cbm status` asks three things in sequence --
   * `initialize`, `tools/list`, then `list_projects` -- and only the last was
   * ever charged a command-sized deadline, so a wedged daemon froze the command
   * for {@link HANDSHAKE_TIMEOUT_MS} on the first. The clock starts at the first
   * request rather than here, so a client built early and used later still gets
   * its whole budget; each request is then charged whichever is smaller, its own
   * deadline or what is left.
   */
  readonly totalTimeoutMs?: number;
  /** Where a failure is recorded. Nothing here reaches the operator. */
  readonly onDebug?: (message: string) => void;
}

/**
 * A client for `executable`, which is not started until something is asked of
 * it.
 *
 * Lazy on purpose: a session that never searches never pays the startup, and
 * the feature that holds this client is registered for every session.
 *
 * An open that never reaches a completed handshake is permanent for the
 * client's lifetime. Retrying would spend 2.9 s per attempt on an executable
 * that has already declined once, which is the opposite of the bound this whole
 * module exists to respect.
 *
 * A session that *did* hand shake and was torn down afterwards is a different
 * case, and is reopened at most {@link REOPEN_LIMIT} times. A query that misses
 * its deadline tears the session down, and the augmenter memoises this client
 * for the whole session -- so without a reopen, one transient stall (CPU
 * contention, a reindex, or the daemon restarting under a new pid) would
 * silently disable graph context until the operator restarted OMP. The reopen
 * costs nothing on the hot path: a query never waits for a handshake, so it
 * happens in the background and the searches until it lands append nothing,
 * exactly as they do during a session's first handshake.
 */
export function openGraphClient(executable: string, options: GraphClientOptions = {}): GraphClient {
  const queryTimeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs;
  const debug = options.onDebug ?? ((): void => {});

  /**
   * When the shared budget runs out, or `null` while there is none or it has not
   * started.
   *
   * Started by the first request rather than by this call, so a client held for a
   * while before it is used does not arrive with its budget already spent.
   */
  let expiresAt: number | null = null;

  /**
   * `timeoutMs`, narrowed by whatever is left of the shared budget.
   *
   * Returns `timeoutMs` untouched when no budget was set, which is what keeps
   * the augmentation's 300 ms query bound and its 20 s background handshake
   * exactly as they were. A budget already spent yields `0`, and a deadline of
   * `0` is honest rather than a special case: the request is written, the
   * deadline fires on the next turn, and the session is torn down by the same
   * path that handles every other expiry.
   */
  const budgeted = (timeoutMs: number): number => {
    if (totalTimeoutMs === undefined) return timeoutMs;
    expiresAt ??= Date.now() + totalTimeoutMs;
    return Math.max(0, Math.min(timeoutMs, expiresAt - Date.now()));
  };

  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  let handshake: Promise<boolean> | null = null;
  /**
   * Whether the session that is up has completed its handshake.
   *
   * Synchronous on purpose: it is what lets a query answer "not ready" without
   * awaiting anything. Cleared by `teardown` together with the child, so it can
   * never describe a session that is gone.
   */
  let established = false;
  /** An open that never reached a completed handshake, which is permanent. */
  let declined = false;
  /** How many sessions this client has started, against {@link REOPEN_LIMIT}. */
  let opens = 0;
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, (message: unknown) => void>();

  /** One session's child, as the code that owns it holds it. */
  type Child = Bun.Subprocess<"pipe", "pipe", "pipe">;

  /**
   * Fails every in-flight request and forgets `owner`.
   *
   * `owner` is the child the caller was talking to, and the check against it is
   * not ceremony: a drain loop and a timed-out request both outlive the session
   * they belong to. The pipe ends *after* the kill, by which time a reopen can
   * already have spawned a replacement -- and an unchecked teardown would then
   * kill the replacement and fail the handshake it was in the middle of.
   */
  const teardown = (reason: string, owner: Child | null): void => {
    if (owner !== child) return;
    for (const settle of pending.values()) settle({ error: { message: reason } });
    pending.clear();
    const dying = child;
    child = null;
    // The handshake described the child that is going away, so it is forgotten
    // with it: `ready()` must not answer `true` for a session that no longer
    // exists, and a later query must be able to open a new one.
    handshake = null;
    established = false;
    if (dying === null) return;
    try {
      // stdin first: closing it is how an MCP stdio server is told to stop, and
      // it lets the shared daemon see a clean disconnect.
      dying.stdin.end();
    } catch {
      // Already closed, which is the desired state.
    }
    try {
      dying.kill();
    } catch {
      // Already gone.
    }
  };

  /** Drains one pipe of `owner` into `onLine`, bounded, and ends that session when it stops. */
  const drain = (owner: Child, stream: ReadableStream<Uint8Array>, onLine: ((line: string) => void) | null): void => {
    void (async (): Promise<void> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (onLine === null) continue;
          buffer += decoder.decode(value, { stream: true });
          // A response larger than the cap is not parsed. Both pipes are read
          // into this process's memory and a session holds this client for its
          // whole lifetime, so an unbounded buffer is a leak with a long lease.
          if (buffer.length > OUTPUT_LIMIT_BYTES) {
            teardown(`the graph session wrote more than ${OUTPUT_LIMIT_BYTES} bytes without a complete line`, owner);
            return;
          }
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            onLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
        }
      } catch (error) {
        debug(`graph session read failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await reader.cancel().catch(() => {});
        if (onLine !== null) teardown("the graph session ended", owner);
      }
    })();
  };

  const receive = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON line on stdout is a log the server should not have written
      // there. Ignored rather than fatal: the pending request keeps its deadline.
      return;
    }
    if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) return;
    const id = parsed.id;
    if (typeof id !== "number") return;
    const settle = pending.get(id);
    if (settle === undefined) return;
    pending.delete(id);
    settle(parsed);
  };

  /**
   * Sends one request and waits for its response or the deadline.
   *
   * Built on {@link AbortSignal.timeout} rather than a timer callback, for the
   * reason `src/scheduler.ts` gives: a raw timer callback that throws escapes
   * handler dispatch and takes the session with it. The one callback below
   * resolves a promise and does nothing else, so there is nothing in it to
   * throw.
   *
   * `timeoutMs` is the caller's own bound and `budgeted` is what a shared budget
   * narrows it to, so the reported deadline is the one that was actually
   * enforced rather than the one that was asked for.
   */
  const request = async (method: string, params: unknown, timeoutMs: number): Promise<unknown | null> => {
    const active = child;
    if (active === null) return null;

    const id = ++nextId;
    const bound = budgeted(timeoutMs);
    const answered = Promise.withResolvers<unknown>();
    pending.set(id, answered.resolve);
    const deadline = AbortSignal.timeout(bound);
    const expired = Promise.withResolvers<typeof EXPIRED>();
    deadline.addEventListener("abort", () => expired.resolve(EXPIRED), { once: true });

    try {
      active.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      await active.stdin.flush();
    } catch (error) {
      pending.delete(id);
      teardown(
        `the graph session would not accept a request: ${error instanceof Error ? error.message : String(error)}`,
        active,
      );
      return null;
    }

    const response = await Promise.race([answered.promise, expired.promise]);
    if (response === EXPIRED) {
      pending.delete(id);
      // Torn down rather than left running: a request that missed its deadline
      // leaves a reply in the pipe, and a server slow enough to miss 300 ms is
      // one this package should stop asking rather than keep a queue for.
      teardown(`${method} did not answer within ${bound}ms`, active);
      debug(`graph query ${method} exceeded ${bound}ms`);
      return null;
    }
    if (typeof response !== "object" || response === null) return null;

    if ("error" in response) {
      const failure = response.error;
      const reported =
        typeof failure === "object" && failure !== null && "message" in failure && typeof failure.message === "string"
          ? failure.message
          : "unknown";
      debug(`graph query ${method} failed: ${reported}`);
      return null;
    }
    return "result" in response ? response.result ?? null : null;
  };

  /** Starts one child and completes the MCP handshake against it. */
  const open = async (): Promise<boolean> => {
    let started: Child;
    try {
      started = Bun.spawn([executable], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
    } catch (error) {
      debug(`graph session would not start: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    child = started;

    drain(started, started.stdout, receive);
    // CBM writes `level=info` lines to stderr on every start. Drained and
    // discarded, because a pipe nobody reads blocks the writer.
    drain(started, started.stderr, null);

    const initialized = await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "omp-codebase-memory", version: "0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    if (initialized === null) {
      teardown("the graph session did not complete its handshake", started);
      return false;
    }

    // A teardown during the handshake has already dropped this child, and may
    // have started its replacement; finishing the handshake against either
    // would be talking to a session nobody holds.
    if (child !== started) return false;
    try {
      started.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      await started.stdin.flush();
    } catch (error) {
      teardown(
        "the graph session would not accept the initialized notification: " +
          `${error instanceof Error ? error.message : String(error)}`,
        started,
      );
      return false;
    }
    // The session can still die during that flush, and readiness must never
    // outlive the child it describes.
    if (child !== started) return false;
    established = true;
    return true;
  };

  /**
   * The session, opened if it is not up, at most once concurrently.
   *
   * Awaiting this is the slow path, and only two callers take it: `toolNames()`
   * for the drift check, and `/cbm status` through it, both of which have an
   * operator waiting for an answer. A tool result never waits here.
   */
  const ready = async (): Promise<boolean> => {
    if (closed || declined) return false;
    const inFlight = handshake;
    if (inFlight !== null) return await inFlight;
    if (opens > REOPEN_LIMIT) return false;
    opens += 1;

    const started = open();
    handshake = started;
    const opened = await started;
    if (!opened) {
      declined = true;
      // `teardown` clears this on the paths that had a child to tear down; a
      // spawn that threw has none and clears it here.
      if (handshake === started) handshake = null;
    }
    return opened;
  };

  /**
   * Whether the session is ready, answered without waiting for anything.
   *
   * The handshake is the one slow thing here, and it must never be charged to a
   * tool result. Measured: ~2.9 s against a warm daemon and ~9 s when the daemon
   * has to start. Waiting even the query deadline for it buys nothing -- a
   * handshake that has not landed will not land inside 300 ms -- while costing
   * every tool result in that window the full deadline for an answer that was
   * always going to be "not ready" (measured 304 ms against a 6602 ms
   * handshake). So the handshake is started, `false` is answered immediately,
   * and the next search finds it done. The first searches in a session may
   * therefore append nothing; that is the correct trade against holding up the
   * operator's `grep`.
   */
  const readyNow = (): boolean => {
    // Started, never awaited. `ready()` answers `false` rather than rejecting on
    // every failure it knows about; the `catch` keeps that true of a later edit
    // instead of letting it become an unhandled rejection.
    void ready().catch(() => {});
    return established;
  };

  return {
    async call(tool, args) {
      if (!readyNow()) return null;
      const result = await request("tools/call", { name: tool, arguments: args }, queryTimeoutMs);
      if (typeof result !== "object" || result === null) return null;
      if ("isError" in result && result.isError === true) {
        debug(`graph tool ${tool} reported an error`);
        return null;
      }
      return "structuredContent" in result ? result.structuredContent ?? null : null;
    },

    async toolNames() {
      if (!(await ready())) return null;
      const result = await request("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      if (typeof result !== "object" || result === null || !("tools" in result)) return null;
      const tools = result.tools;
      if (!Array.isArray(tools)) return null;
      return tools
        .map((tool: unknown) =>
          typeof tool === "object" && tool !== null && "name" in tool ? tool.name : undefined,
        )
        .filter((name): name is string => typeof name === "string");
    },

    close() {
      closed = true;
      // Whatever session is up, which is also `null` when none is: the owner
      // check then makes this the no-op a second `close()` has to be.
      teardown("the graph session was closed", child);
    },
  };
}

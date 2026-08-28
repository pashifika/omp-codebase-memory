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

/** How long the handshake may take. Generous: it is paid once, off any blocking path. */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * How long one query may take.
 *
 * Low hundreds of milliseconds, because this is paid on every search in every
 * session including subagents. A warm session answers in ~14 ms, so this bounds
 * a stall rather than the ordinary case.
 */
export const QUERY_TIMEOUT_MS = 300;

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
 * A failed open is permanent for the client's lifetime. Retrying would spend
 * 2.9 s per attempt on an executable that has already declined once, which is
 * the opposite of the bound this whole module exists to respect.
 */
export function openGraphClient(executable: string, options: GraphClientOptions = {}): GraphClient {
  const queryTimeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
  const debug = options.onDebug ?? ((): void => {});

  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  let handshake: Promise<boolean> | null = null;
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, (message: unknown) => void>();

  /** Fails every in-flight request and forgets the child. */
  const teardown = (reason: string): void => {
    for (const settle of pending.values()) settle({ error: { message: reason } });
    pending.clear();
    const dying = child;
    child = null;
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

  /** Drains one pipe into `onLine`, bounded, and tears the session down when it ends. */
  const drain = (stream: ReadableStream<Uint8Array>, onLine: ((line: string) => void) | null): void => {
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
            teardown(`the graph session wrote more than ${OUTPUT_LIMIT_BYTES} bytes without a complete line`);
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
        if (onLine !== null) teardown("the graph session ended");
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
   * handler dispatch and takes the session with it. There is no callback here.
   */
  const request = async (method: string, params: unknown, timeoutMs: number): Promise<unknown | null> => {
    const active = child;
    if (active === null) return null;

    const id = ++nextId;
    const answered = Promise.withResolvers<unknown>();
    pending.set(id, answered.resolve);
    const deadline = AbortSignal.timeout(timeoutMs);
    const expired = Promise.withResolvers<typeof EXPIRED>();
    deadline.addEventListener("abort", () => expired.resolve(EXPIRED), { once: true });

    try {
      active.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      await active.stdin.flush();
    } catch (error) {
      pending.delete(id);
      teardown(
        `the graph session would not accept a request: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const response = await Promise.race([answered.promise, expired.promise]);
    if (response === EXPIRED) {
      pending.delete(id);
      // Torn down rather than left running: a request that missed its deadline
      // leaves a reply in the pipe, and a server slow enough to miss 300 ms is
      // one this package should stop asking rather than keep a queue for.
      teardown(`${method} did not answer within ${timeoutMs}ms`);
      debug(`graph query ${method} exceeded ${timeoutMs}ms`);
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

  /** Starts the child and completes the MCP handshake, at most once. */
  const ready = async (): Promise<boolean> => {
    if (closed) return false;
    if (handshake !== null) return await handshake;

    handshake = (async (): Promise<boolean> => {
      try {
        child = Bun.spawn([executable], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
      } catch (error) {
        debug(`graph session would not start: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }

      drain(child.stdout, receive);
      // CBM writes `level=info` lines to stderr on every start. Drained and
      // discarded, because a pipe nobody reads blocks the writer.
      drain(child.stderr, null);

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
        teardown("the graph session did not complete its handshake");
        return false;
      }

      const active = child;
      if (active === null) return false;
      try {
        active.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
        await active.stdin.flush();
      } catch (error) {
        teardown(
          "the graph session would not accept the initialized notification: " +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
      return true;
    })();

    return await handshake;
  };

  return {
    async call(tool, args) {
      if (!(await ready())) return null;
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
      teardown("the graph session was closed");
    },
  };
}

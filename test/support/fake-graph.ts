import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * A stand-in MCP stdio server, so `src/graph.ts` can be tested for real.
 *
 * Not a CBM executable and not a network client: a Bun script that speaks
 * newline-delimited JSON-RPC on stdio, which is the whole contract the graph
 * client depends on. The behaviours a test needs to provoke -- a stalled
 * answer, a torn-down pipe, an unparseable line, a flood -- are all things a
 * server does, so they are configured here rather than mocked at the module
 * boundary where the client's own framing would go untested.
 *
 * The delays are real, and deliberately so: the subject under test is a deadline
 * enforced against a separate process, and no clock this side controls reaches
 * that process. A test that needs to observe a deadline being met polls for the
 * condition rather than sleeping for a guessed duration.
 */
export interface FakeGraphOptions {
  /** `structuredContent` per tool name. A tool not listed answers `isError`. */
  readonly tools?: Readonly<Record<string, unknown>>;
  /** The names `tools/list` reports. Omitted means the key is absent from the result. */
  readonly toolNames?: readonly string[];
  /** How long a `tools/call` waits before answering. Used to exceed the deadline. */
  readonly delayMs?: number;
  /**
   * The one tool {@link delayMs} applies to. Omitted delays every
   * `tools/call`.
   *
   * A test that watches a session recover from a missed deadline needs the
   * replacement session to answer, and a delay counted per process would stall
   * that one too -- so the delay is aimed at a tool rather than at a count.
   */
  readonly delayTool?: string;
  /** Exit without answering `initialize`. */
  readonly refuseHandshake?: boolean;
  /** How long `initialize` waits before answering, to outlast a caller's deadline. */
  readonly handshakeDelayMs?: number;
  /**
   * How long `tools/list` waits before answering.
   *
   * The second stall a caller waiting for readiness pays. A server that hand
   * shakes and then goes quiet is not the same failure as one that never hand
   * shakes: the client marks the session established, so a caller's handshake
   * bound is already spent and only what governs this request is left.
   */
  readonly toolListDelayMs?: number;
  /** Answer `tools/call` with a line that is not JSON. */
  readonly garbage?: boolean;
  /** Answer `tools/call` with one line longer than the client's cap. */
  readonly flood?: boolean;
  /** Exit as soon as a `tools/call` arrives, so the pipe closes mid-request. */
  readonly exitOnCall?: boolean;
  /** Answer `list_projects` with the environment the process was given. */
  readonly echoEnv?: boolean;
  /**
   * A file each started stdio session appends its pid to.
   *
   * The only way a test can tell "did not retry" from "retried and failed
   * again": both answer `null`, and the difference is whether a second process
   * exists. Read it with {@link recordedStarts}. A `--version` invocation is
   * not a session and is not recorded.
   */
  readonly startLog?: string;
  /** The version `--version` reports, so the fake can stand in as the resolved executable. */
  readonly version?: string;
}

/**
 * Writes an executable fake server at `file`.
 *
 * The options travel as an inlined JSON literal rather than through `argv`, so
 * the script is self-contained and the client can invoke it exactly the way it
 * invokes the real executable: by path, with no arguments.
 */
export async function writeFakeGraph(file: string, options: FakeGraphOptions = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, `#!/usr/bin/env bun\nconst options = ${JSON.stringify(options)};\n${SERVER}`);
  await chmod(file, 0o755);
}

/**
 * The pids of the sessions a fake with `startLog` has started, in order.
 *
 * An absent file means none: the client is lazy, so "nothing started" is the
 * state where the log was never created.
 */
export async function recordedStarts(file: string): Promise<readonly number[]> {
  const log = Bun.file(file);
  if (!(await log.exists())) return [];
  return (await log.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number.parseInt(line, 10));
}

const SERVER = String.raw`
import { appendFileSync } from "node:fs";

// Answered before anything else and without recording a start: resolution asks
// the candidate for its version, and that invocation is not a session.
if (process.argv.includes("--version")) {
  process.stdout.write("codebase-memory-mcp " + (options.version ?? "0.0.0") + "\n");
  process.exit(0);
}
if (options.startLog !== undefined) appendFileSync(options.startLog, process.pid + "\n");

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.trim() === "") continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue;

    if (request.method === "initialize") {
      if (options.refuseHandshake === true) process.exit(1);
      if (options.handshakeDelayMs !== undefined) await Bun.sleep(options.handshakeDelayMs);
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05" } });
      continue;
    }

    if (request.method === "tools/list") {
      if (options.toolListDelayMs !== undefined) await Bun.sleep(options.toolListDelayMs);
      const result = options.toolNames === undefined ? {} : { tools: options.toolNames.map((name) => ({ name })) };
      send({ jsonrpc: "2.0", id: request.id, result });
      continue;
    }

    if (request.method === "tools/call") {
      if (options.exitOnCall === true) process.exit(0);
      const tool = request.params?.name;
      if (options.delayMs !== undefined && (options.delayTool === undefined || options.delayTool === tool)) {
        await Bun.sleep(options.delayMs);
      }
      if (options.garbage === true) {
        process.stdout.write("this is not json\n");
        continue;
      }
      if (options.flood === true) {
        process.stdout.write("x".repeat(300_000));
        continue;
      }

      if (options.echoEnv === true && tool === "list_projects") {
        send({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { env: process.env }, isError: false } });
        continue;
      }
      const answer = options.tools?.[tool];
      if (answer === undefined) {
        send({ jsonrpc: "2.0", id: request.id, result: { content: [], isError: true } });
        continue;
      }
      send({ jsonrpc: "2.0", id: request.id, result: { structuredContent: answer, isError: false } });
      continue;
    }

    send({ jsonrpc: "2.0", id: request.id, error: { message: "unknown method " + request.method } });
  }
});
`;

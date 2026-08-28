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
 */
export interface FakeGraphOptions {
  /** `structuredContent` per tool name. A tool not listed answers `isError`. */
  readonly tools?: Readonly<Record<string, unknown>>;
  /** The names `tools/list` reports. Omitted means the key is absent from the result. */
  readonly toolNames?: readonly string[];
  /** How long a `tools/call` waits before answering. Used to exceed the deadline. */
  readonly delayMs?: number;
  /** Exit without answering `initialize`. */
  readonly refuseHandshake?: boolean;
  /** Answer `tools/call` with a line that is not JSON. */
  readonly garbage?: boolean;
  /** Answer `tools/call` with one line longer than the client's cap. */
  readonly flood?: boolean;
  /** Exit as soon as a `tools/call` arrives, so the pipe closes mid-request. */
  readonly exitOnCall?: boolean;
  /** Answer `list_projects` with the environment the process was given. */
  readonly echoEnv?: boolean;
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

const SERVER = String.raw`
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
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05" } });
      continue;
    }

    if (request.method === "tools/list") {
      const result = options.toolNames === undefined ? {} : { tools: options.toolNames.map((name) => ({ name })) };
      send({ jsonrpc: "2.0", id: request.id, result });
      continue;
    }

    if (request.method === "tools/call") {
      if (options.exitOnCall === true) process.exit(0);
      if (options.delayMs !== undefined) await Bun.sleep(options.delayMs);
      if (options.garbage === true) {
        process.stdout.write("this is not json\n");
        continue;
      }
      if (options.flood === true) {
        process.stdout.write("x".repeat(300_000));
        continue;
      }

      const tool = request.params?.name;
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

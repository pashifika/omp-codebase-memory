import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { openGraphClient, QUERY_TIMEOUT_MS } from "../../src/graph.ts";
import { dropScratch, makeScratch, type Scratch } from "../support/scratch.ts";
import { writeFakeGraph, type FakeGraphOptions } from "../support/fake-graph.ts";

import type { GraphClient } from "../../src/graph.ts";

/**
 * The stdio client, against a fake server rather than a mock.
 *
 * The framing is the part most likely to be wrong -- newline delimiting, id
 * correlation, the deadline, the teardown -- and none of it is exercised by
 * replacing the client with a stub. The fake is a Bun script that speaks the
 * same protocol; no CBM executable and no network is involved.
 */

let scratch: Scratch;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await dropScratch(scratch);
});

/** A client over a fake server configured by `options`. */
async function fakeClient(options: FakeGraphOptions, queryTimeoutMs = QUERY_TIMEOUT_MS): Promise<GraphClient> {
  const executable = path.join(scratch.root, "fake-graph");
  await writeFakeGraph(executable, options);
  return openGraphClient(executable, { queryTimeoutMs });
}

/**
 * Completes the handshake without charging it to a query deadline.
 *
 * `toolNames` is the drift check's entry point and waits for the handshake on
 * purpose, so it is also the warm-up primitive a test needs: every assertion
 * about an *answer* has to happen on a ready session, because a query
 * deliberately refuses to wait for the handshake.
 */
async function warm(client: GraphClient): Promise<void> {
  await client.toolNames();
}

describe("a working session", () => {
  test("returns a tool's structured content", async () => {
    const client = await fakeClient({ tools: { list_projects: { projects: [{ name: "p", root_path: "/w" }] } } });
    try {
      await warm(client);
      expect(await client.call("list_projects", {})).toEqual({ projects: [{ name: "p", root_path: "/w" }] });
    } finally {
      client.close();
    }
  });

  test("pays the handshake once across several queries", async () => {
    const client = await fakeClient({ tools: { list_projects: { projects: [] } } });
    try {
      await warm(client);
      // Correlation by id is what makes this safe; a second handshake would
      // reset the ids and the second answer would be dropped.
      expect(await client.call("list_projects", {})).toEqual({ projects: [] });
      expect(await client.call("list_projects", {})).toEqual({ projects: [] });
    } finally {
      client.close();
    }
  });

  test("reports the server's tool names", async () => {
    const client = await fakeClient({ toolNames: ["search_graph", "list_projects"] });
    try {
      expect(await client.toolNames()).toEqual(["search_graph", "list_projects"]);
    } finally {
      client.close();
    }
  });

  test("passes no cache-root override, so the daemon's own root is the one used", async () => {
    const client = await fakeClient({ echoEnv: true });
    try {
      await warm(client);
      const answered = await client.call("list_projects", {});
      expect(answered).not.toBeNull();
      const env = (answered as { env: Record<string, string | undefined> }).env;
      // Exactly what this process has, which is the claim: the client adds no
      // `CBM_CACHE_DIR`, and CBM refuses a command configured against a root
      // other than the active daemon's.
      expect(env["CBM_CACHE_DIR"]).toBe(process.env["CBM_CACHE_DIR"]);
    } finally {
      client.close();
    }
  });
});

interface FailureCase {
  readonly scenario: string;
  readonly options: FakeGraphOptions;
  /** A tighter deadline where the case is about exceeding it. */
  readonly queryTimeoutMs?: number;
  /**
   * Complete the handshake first, so the failure under test is the query's own.
   * Omitted where the handshake is the failure.
   */
  readonly warmFirst?: boolean;
}

/**
 * Every way a query can fail, each answering `null`.
 *
 * `null` is the whole contract: the augmentation appends nothing and the
 * original tool result reaches the model untouched. A throw here would be
 * caught by OMP and reported, which is exactly the noise the client exists to
 * avoid.
 */
const failureCases: FailureCase[] = [
  { scenario: "a server that never answers the handshake yields null", options: { refuseHandshake: true } },
  {
    scenario: "a query that exceeds its deadline yields null",
    options: { tools: { list_projects: { projects: [] } }, delayMs: 400 },
    queryTimeoutMs: 50,
    warmFirst: true,
  },
  { scenario: "a server that exits mid-request yields null", options: { exitOnCall: true }, warmFirst: true },
  { scenario: "an unparseable answer yields null", options: { garbage: true }, warmFirst: true },
  { scenario: "an answer larger than the cap yields null", options: { flood: true }, warmFirst: true },
  { scenario: "a tool that reports isError yields null", options: { tools: {} }, warmFirst: true },
];

test.each(failureCases)("$scenario", async ({ options, queryTimeoutMs, warmFirst }) => {
  const client = await fakeClient(options, queryTimeoutMs ?? QUERY_TIMEOUT_MS);
  try {
    if (warmFirst === true) await warm(client);
    expect(await client.call("list_projects", {})).toBeNull();
  } finally {
    client.close();
  }
});

test("an executable that does not exist yields null rather than throwing", async () => {
  const client = openGraphClient(path.join(scratch.root, "absent"), { queryTimeoutMs: 100 });
  try {
    expect(await client.call("list_projects", {})).toBeNull();
    expect(await client.toolNames()).toBeNull();
  } finally {
    client.close();
  }
});

/**
 * The handshake must never be charged to a tool result.
 *
 * Measured against the real executable: ~2.9 s against a warm daemon and ~9 s
 * when the daemon has to start. A query that waited for that would hold up the
 * operator's `grep` for seconds, which is precisely what the deadline exists to
 * prevent -- so the first query returns nothing within its own deadline while the
 * handshake continues, and a later one finds the session ready.
 */
test("a query does not wait for a slow handshake, and a later one succeeds", async () => {
  const client = await fakeClient(
    { tools: { list_projects: { projects: [] } }, handshakeDelayMs: 400 },
    100,
  );
  try {
    const started = performance.now();
    expect(await client.call("list_projects", {})).toBeNull();
    const waited = performance.now() - started;
    // Its own deadline, not the handshake's: generous enough for a loaded CI
    // runner, far below the 400 ms the server is holding the handshake for.
    expect(waited).toBeLessThan(350);

    // Polled, not slept: the client exposes no readiness signal, and a
    // successful answer *is* readiness. Each attempt is bounded by the same
    // deadline, so this converges as soon as the handshake lands rather than
    // after a duration guessed here.
    let answered: unknown = null;
    for (let attempt = 0; attempt < 40 && answered === null; attempt += 1) {
      answered = await client.call("list_projects", {});
    }
    expect(answered).toEqual({ projects: [] });
  } finally {
    client.close();
  }
});

test("a closed client answers null without starting anything", async () => {
  const client = await fakeClient({ tools: { list_projects: { projects: [] } } });
  client.close();
  expect(await client.call("list_projects", {})).toBeNull();
  // Closing twice is a no-op rather than a throw, because `session_shutdown`
  // can arrive after a failure already tore the session down.
  client.close();
});

test("a failed open is not retried, so a declining executable costs one attempt", async () => {
  const client = openGraphClient(path.join(scratch.root, "absent"), { queryTimeoutMs: 100 });
  try {
    expect(await client.call("list_projects", {})).toBeNull();
    expect(await client.call("search_graph", {})).toBeNull();
  } finally {
    client.close();
  }
});

/**
 * The cache-root prohibition, as a property of the source.
 *
 * The behavioural half above proves the child inherits this process's
 * environment. This half proves no module on the graph path names the variable
 * at all, which is what stops a later change from reintroducing an override in
 * a place the behavioural test does not reach.
 */
test("no module on the graph path names a cache-root variable", async () => {
  const modules = ["src/graph.ts", "src/project.ts", "src/augment.ts", "src/augment-entry.ts"];
  for (const module of modules) {
    const source = await Bun.file(path.resolve(import.meta.dir, "..", "..", module)).text();
    expect(source).not.toContain("CBM_CACHE_DIR");
  }
});

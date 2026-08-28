import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { openGraphClient, QUERY_TIMEOUT_MS } from "../../src/graph.ts";
import { dropScratch, makeScratch, type Scratch } from "../support/scratch.ts";
import { recordedStarts, writeFakeGraph, type FakeGraphOptions } from "../support/fake-graph.ts";

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

/**
 * The budget for a test that spawns the fake server.
 *
 * Measured on this repository: the first execution of a freshly written script
 * through its `#!/usr/bin/env bun` shebang costs ~340 ms on an idle machine, and
 * seconds under CPU contention -- and every test here writes a new one, because
 * the options travel inlined in the script. Bun's 5 s default is therefore a
 * budget these tests can exhaust on a loaded runner while testing nothing about
 * the subject, so it is replaced by one generous enough that a timeout means the
 * client actually hung.
 */
const SPAWN_BUDGET_MS = 30_000;

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

/**
 * Waits for `condition`, polling rather than sleeping a guessed duration.
 *
 * The tick is a real one, deliberately: what is being waited for happens in
 * another process -- a child dying, a handshake landing -- and a fake clock in
 * this process does not reach it. Polling for the condition is what keeps the
 * wait proportional to the machine instead of to a number guessed here, and the
 * budget only bounds a failure.
 */
async function until(condition: () => boolean | Promise<boolean>, budgetMs = 10_000): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    if (await condition()) return true;
    if (performance.now() >= deadline) return false;
    await Bun.sleep(20);
  }
}

/** Whether `pid` still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of the fake's `index`-th session, failing the test when it never started. */
async function startedPid(file: string, index: number): Promise<number> {
  const starts = await recordedStarts(file);
  const pid = starts[index];
  expect(pid).toBeDefined();
  if (pid === undefined) throw new Error(`the fake started no session ${index}`);
  return pid;
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
  }, SPAWN_BUDGET_MS);

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
  }, SPAWN_BUDGET_MS);

  test("reports the server's tool names", async () => {
    const client = await fakeClient({ toolNames: ["search_graph", "list_projects"] });
    try {
      expect(await client.toolNames()).toEqual(["search_graph", "list_projects"]);
    } finally {
      client.close();
    }
  }, SPAWN_BUDGET_MS);

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
  }, SPAWN_BUDGET_MS);
});

interface FailureCase {
  readonly scenario: string;
  readonly options: FakeGraphOptions;
  /** A tighter deadline where the case is about exceeding it. */
  readonly queryTimeoutMs?: number;
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
  },
  { scenario: "a server that exits mid-request yields null", options: { exitOnCall: true } },
  { scenario: "an unparseable answer yields null", options: { garbage: true } },
  { scenario: "an answer larger than the cap yields null", options: { flood: true } },
  { scenario: "a tool that reports isError yields null", options: { tools: {} } },
];

test.each(failureCases)("$scenario", async ({ options, queryTimeoutMs }) => {
  const client = await fakeClient(options, queryTimeoutMs ?? QUERY_TIMEOUT_MS);
  try {
    // Every case settles the handshake first, including the one whose handshake
    // is the failure. A query does not wait for a handshake, so without this
    // each case would answer `null` for the trivial reason that the session was
    // not ready yet and never reach the failure it names.
    await warm(client);
    expect(await client.call("list_projects", {})).toBeNull();
  } finally {
    client.close();
  }
}, SPAWN_BUDGET_MS);

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
  const handshakeDelayMs = 2_000;
  const client = await fakeClient({ tools: { list_projects: { projects: [] } }, handshakeDelayMs }, 100);
  try {
    const started = performance.now();
    expect(await client.call("list_projects", {})).toBeNull();
    const waited = performance.now() - started;
    // The property is that the query did not wait for the handshake, so the
    // bound is a fraction of the handshake rather than a multiple of the
    // deadline. The first call also spawns the process, and process spawn on a
    // loaded runner is what a bound close to the deadline would race.
    expect(waited).toBeLessThan(handshakeDelayMs / 2);

    // Polled, not counted: a query no longer costs its deadline to answer "not
    // ready", so a fixed number of attempts would all land inside the handshake
    // window and prove nothing. A successful answer *is* readiness, and the
    // poll converges as soon as the handshake lands.
    let answered: unknown = null;
    expect(await until(async () => (answered = await client.call("list_projects", {})) !== null)).toBe(true);
    expect(answered).toEqual({ projects: [] });
  } finally {
    client.close();
  }
}, SPAWN_BUDGET_MS);

test("a closed client answers null without starting anything", async () => {
  const starts = path.join(scratch.root, "starts");
  const client = await fakeClient({ tools: { list_projects: { projects: [] } }, startLog: starts });
  client.close();

  expect(await client.call("list_projects", {})).toBeNull();
  expect(await client.toolNames()).toBeNull();
  // Closing twice is a no-op rather than a throw, because `session_shutdown`
  // can arrive after a failure already tore the session down.
  client.close();

  // The half the `null` above cannot show: a client closed before its first
  // query must never spawn the executable, which is what makes `close()` on a
  // session that never searched free rather than merely quiet.
  expect(await recordedStarts(starts)).toEqual([]);
}, SPAWN_BUDGET_MS);

/**
 * An executable that will not hand shake is asked exactly once.
 *
 * Two `null`s do not show this: a client that retried every query would answer
 * `null` twice as well, at 2.9 s of handshake apiece against the real binary.
 * The recorded starts are the difference, so the assertion is a count of
 * processes rather than a count of failures.
 */
test("a failed open is not retried, so a declining executable costs one attempt", async () => {
  const starts = path.join(scratch.root, "starts");
  const client = await fakeClient({ refuseHandshake: true, startLog: starts });
  try {
    // `toolNames` waits for the handshake, so the failure has actually happened
    // before the next attempt is made rather than still being in flight.
    expect(await client.toolNames()).toBeNull();
    expect(await client.toolNames()).toBeNull();
    expect(await client.call("list_projects", {})).toBeNull();

    expect(await recordedStarts(starts)).toHaveLength(1);
  } finally {
    client.close();
  }
}, SPAWN_BUDGET_MS);

/**
 * The sessions one client may start: the initial one plus the reopen ceiling.
 *
 * Named here rather than imported, because `src/graph.ts` keeps `REOPEN_LIMIT`
 * private and a test that reads the subject's own constant asserts nothing about
 * the number. What is asserted is the ceiling's existence and where it lands, so
 * a change to it has to be made here too, deliberately.
 */
const SESSION_CEILING = 3;

/**
 * A query that misses its deadline ends the session, the next one reopens it,
 * and the reopening stops.
 *
 * Three halves of one contract, which is what makes this one test rather than
 * three. `graph-augmentation "Scenario: Deadline exceeded"` requires the
 * subprocess to be terminated, and the reason is in the client: the reply to the
 * abandoned request is still coming down that pipe, so the session cannot be
 * reused as it stands. Asserting only the `null` leaves the termination
 * unchecked, which is how a torn-down child could have been left running.
 *
 * The reopen is the second, and it is what stops the termination from being
 * permanent. A torn-down session used to keep the resolved handshake of a child
 * that no longer existed, so every later query answered `null` for the rest of
 * the session -- one stall, and a session-long client with no graph context. The
 * recorded starts are what distinguish a reopened session from a reused one, and
 * the timing assertion says the reopen is paid in the background exactly as the
 * first handshake is.
 *
 * The ceiling is the third, and it is the clause `graph-augmentation "Scenario:
 * Queries share a persistent session"` states: an established session that ended
 * early is replaced *at most a bounded number of times*. A reopen per stall is
 * what that clause forbids, and against the real binary it would spend a ~2.9 s
 * handshake on every query for the rest of a session whose server is sick. The
 * loop below is what exercises it: two halves proved a replacement happens and
 * that a failed FIRST open is not retried, but neither drives a third teardown,
 * so the bound itself rested on code nothing ran. Both directions are asserted,
 * because each fails a different mistake -- the start count says no fourth
 * session was spawned, and the refusal poll says the client did not instead
 * answer from a session it had torn down.
 *
 * The order matters twice. The first follow-up query is issued *before* the dead
 * child is waited for, which is the tight case: the reopen starts while the old
 * session's pipe has not yet reported EOF, so the drain loop of the child that
 * died runs its teardown after the replacement exists. A teardown that did not
 * check which session it belonged to would kill the replacement mid-handshake,
 * and the poll below would never get an answer. And the start log is read after
 * the refusal poll rather than before it, because the fake records its pid at
 * startup: a fourth session spawned but slow to hand shake is caught only by a
 * count taken after every opportunity to spawn it has passed.
 */
test("a query that misses its deadline ends the session, a later one reopens it, and the reopening stops", async () => {
  const starts = path.join(scratch.root, "starts");
  const client = await fakeClient(
    // Only `search_graph` stalls: the replacement session has to be able to
    // answer, or the reopen could not be observed at all.
    {
      tools: { list_projects: { projects: [] }, search_graph: { cols: [], groups: [] } },
      delayMs: 5_000,
      delayTool: "search_graph",
      startLog: starts,
    },
    300,
  );
  try {
    await warm(client);
    const first = await startedPid(starts, 0);

    expect(await client.call("search_graph", {})).toBeNull();

    // Immediately, on purpose -- and it does not wait for the replacement
    // either: a reopen is a handshake, and no query waits for one.
    const asked = performance.now();
    expect(await client.call("list_projects", {})).toBeNull();
    expect(performance.now() - asked).toBeLessThan(100);

    expect(await until(() => !alive(first))).toBe(true);

    expect(await until(async () => (await client.call("list_projects", {})) !== null)).toBe(true);
    const restarted = await recordedStarts(starts);
    expect(restarted).toHaveLength(2);
    expect(restarted[1]).not.toBe(first);

    // Every replacement the ceiling still allows, stalled and recovered the same
    // way, so the count below is reached by repeating the cycle rather than by
    // arranging one special case.
    for (let session = 2; session < SESSION_CEILING; session += 1) {
      expect(await client.call("search_graph", {})).toBeNull();
      expect(await until(async () => (await client.call("list_projects", {})) !== null)).toBe(true);
      expect(await recordedStarts(starts)).toHaveLength(session + 1);
    }

    // One stall past the ceiling.
    const last = await startedPid(starts, SESSION_CEILING - 1);
    expect(await client.call("search_graph", {})).toBeNull();
    expect(await until(() => !alive(last))).toBe(true);

    // Not one refusal but every one this budget affords, each a fresh chance to
    // open a session the ceiling forbids.
    expect(await until(async () => (await client.call("list_projects", {})) !== null, 1_000)).toBe(false);

    const ceiling = await recordedStarts(starts);
    expect(ceiling).toHaveLength(SESSION_CEILING);
    expect(new Set(ceiling).size).toBe(SESSION_CEILING);
  } finally {
    client.close();
  }
}, SPAWN_BUDGET_MS);

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

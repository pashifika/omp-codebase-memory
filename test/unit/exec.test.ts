import { describe, expect, test } from "bun:test";

import { OUTPUT_LIMIT_BYTES, run } from "../../src/exec.ts";

/**
 * The one place this package starts a subprocess, and the two bounds it owes
 * its callers: a deadline, and a byte cap.
 *
 * The child is `process.execPath` -- whatever is running this suite can also
 * run `-e` -- rather than a coreutils pipeline, so the flood is the same size
 * on every host and needs nothing on `PATH`.
 *
 * These cases measure the real clock, which the project otherwise avoids in
 * tests. There is no deterministic substitute: the properties are that a real
 * subprocess is *ended* rather than waited out and that a real deadline wins
 * over a real kernel pipe, and a fake clock advances neither a process's
 * lifetime nor a descendant's grip on a file descriptor. The cost is paid only
 * when the bound is broken -- every assertion below passes in tens of
 * milliseconds and only a regression makes the suite wait.
 */

/** Comfortably past the cap, and small enough to produce in milliseconds. */
const FLOOD_BYTES = OUTPUT_LIMIT_BYTES * 3;

/**
 * How long a lingering child stays alive after it has written.
 *
 * Long enough that waiting for it instead of killing it is unmistakable in the
 * wall clock, and short enough that a broken run still ends.
 */
const LINGER_MS = 8_000;

interface FloodCase {
  readonly scenario: string;
  /** What the child writes, and which pipe it writes it to. */
  readonly emit: string;
  /** The stream that must come back bounded. */
  readonly stream: "stdout" | "stderr";
  /** The refusal must name the stream that overflowed. */
  readonly reported: RegExp;
}

const floods: FloodCase[] = [
  {
    scenario: "a stdout flood is capped and the child is killed",
    emit: `process.stdout.write("a".repeat(${FLOOD_BYTES}))`,
    stream: "stdout",
    reported: /wrote more than \d+ bytes to stdout/u,
  },
  {
    scenario: "a stderr flood is capped and the child is killed",
    emit: `process.stderr.write("a".repeat(${FLOOD_BYTES}))`,
    stream: "stderr",
    reported: /wrote more than \d+ bytes to stderr/u,
  },
  {
    // The case that separates "stopped reading it" from "ended it". A child
    // that floods and then goes on living costs `run` the child's whole
    // remaining lifetime -- inside its deadline the entire time, so no other
    // bound catches it. Without the kill the reviewer measured 8022 ms here.
    scenario: "a child still running after it floods is killed rather than waited out",
    emit: `process.stdout.write("a".repeat(${FLOOD_BYTES})); setTimeout(() => {}, ${LINGER_MS})`,
    stream: "stdout",
    reported: /wrote more than \d+ bytes to stdout/u,
  },
];

/**
 * Children that close both pipes at once and then keep running.
 *
 * `exec 1>/dev/null 2>/dev/null` ends both reads immediately, so a bound that
 * races only the drain lets the deadline pass unnoticed -- process lifetime has
 * to be inside the bound too. Measured before the fix: 2012 ms and `ok: true`
 * for the trapping form, and 102 ms with no `spawnError` at all for the other,
 * which reported a deadline as an anonymous signal death.
 */
const closedPipes = [
  {
    scenario: "a child that closes its pipes and traps SIGTERM is killed at the deadline",
    script: "exec 1>/dev/null 2>/dev/null; trap '' TERM; sleep 2",
  },
  {
    scenario: "a child that closes its pipes and dies on SIGTERM still reports the deadline",
    script: "exec 1>/dev/null 2>/dev/null; sleep 2",
  },
];

test("every case names itself distinctly", () => {
  const scenarios = [...floods, ...closedPipes].map((entry) => entry.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("captured output", () => {
  test.each(floods)("$scenario", async ({ emit, stream, reported }) => {
    const started = Date.now();
    const result = await run([process.execPath, "-e", emit], { timeoutMs: 20_000 });
    const elapsed = Date.now() - started;

    // The deadline bounds how long a child runs, not how much it writes, so a
    // candidate that answers `--version` with a gigabyte would be inside its
    // timeout the whole time it was exhausting this process's memory.
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(reported);
    expect(result[stream].length).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
    expect(elapsed).toBeLessThan(LINGER_MS / 2);
  });

  test("output under the cap comes back whole", async () => {
    const result = await run([process.execPath, "-e", 'process.stdout.write("small")']);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("small");
    expect(result.spawnError).toBeUndefined();
  });

  test("a missing executable is a result rather than a throw", async () => {
    const result = await run(["definitely-not-a-tool-on-this-host"]);

    expect(result.ok).toBe(false);
    expect(result.spawnError).toBeDefined();
  });
});

describe("the deadline", () => {
  test("a descendant holding the pipe open does not outlast the deadline", async () => {
    const started = Date.now();
    // `sh` exits at once; the backgrounded `sleep` inherits the pipe and keeps
    // it open. Draining both pipes before observing the child's exit made the
    // deadline advisory rather than authoritative -- 2014 ms measured against a
    // 100 ms timeout, with `ok` returned as if the read had completed.
    const result = await run(["sh", "-c", "(sleep 2) & printf ok"], { timeoutMs: 100 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/did not finish within 100ms/u);
  });

  test("a child ignoring SIGTERM is gone when the deadline fires", async () => {
    const started = Date.now();
    // An ignored disposition survives `exec`, so the whole pipeline ignores
    // SIGTERM. A deadline a `trap` can outlive is not a deadline.
    const result = await run(["sh", "-c", "trap '' TERM; sleep 5"], { timeoutMs: 200 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/did not finish within 200ms/u);
  });

  test("a descendant is reaped with the child rather than left running", async () => {
    // `sh` backgrounds the sleep, prints its pid, and exits. The pid is on
    // stdout even though the deadline fired, because those bytes had already
    // arrived -- releasing a read abandons what has not come, not what has.
    const held = await run(["sh", "-c", 'sleep 30 & printf %s "$!"'], { timeoutMs: 200 });

    expect(held.ok).toBe(false);
    const descendant = held.stdout.trim();
    expect(descendant).toMatch(/^\d+$/u);

    // `kill -0` asks whether the pid is still there without signalling it, so
    // this needs no wait: the group kill has already happened or it has not.
    const alive = await run(
      ["sh", "-c", `kill -0 ${descendant} 2>/dev/null && echo alive || echo gone`],
      { timeoutMs: 5_000 },
    );

    expect(alive.stdout.trim()).toBe("gone");
  });

  test("a descendant the reap cannot reach still does not hold the deadline", async () => {
    // The residual case, and the one that separates releasing the readers from
    // only killing. The grandchild is itself `detached`, so it leads its own
    // session, leaves the group the reap can signal, and survives -- while
    // still holding the stdout it inherited. Nothing portable can find it, so
    // the bound has to come from abandoning the read.
    const escaping =
      'const held = Bun.spawn(["sleep", "30"], ' +
      '{ stdout: "inherit", stderr: "ignore", stdin: "ignore", detached: true }); ' +
      "process.stdout.write(String(held.pid));";

    const started = Date.now();
    const result = await run([process.execPath, "-e", escaping], { timeoutMs: 200 });
    const elapsed = Date.now() - started;

    try {
      expect(elapsed).toBeLessThan(2_000);
      expect(result.ok).toBe(false);
      expect(result.spawnError).toMatch(/did not finish within 200ms/u);
    } finally {
      // It outlives the reap by design, so this test has to end it itself.
      await run(["sh", "-c", `kill -9 ${result.stdout.trim()} 2>/dev/null || true`], {
        timeoutMs: 5_000,
      });
    }
  });

  test.each(closedPipes)("$scenario", async ({ script }) => {
    const started = Date.now();
    const result = await run(["sh", "-c", script], { timeoutMs: 100 });
    const elapsed = Date.now() - started;

    // The read settling is not the process finishing. Racing only the drain
    // left `child.exited` awaited with nothing bounding it, so a child that
    // hands back its pipes and lives on set its own duration.
    expect(elapsed).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/did not finish within 100ms/u);
  });
});

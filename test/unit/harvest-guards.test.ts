import { describe, expect, test } from "bun:test";

import {
  classifyDaemonStatus,
  daemonRefusal,
  OVERRIDE_FLAG,
  overrideReport,
  requireClients,
  type DaemonState,
} from "../../src/harvest/guards.ts";
import { HarvestError } from "../../src/harvest/transform.ts";

/**
 * The harvest's refusals, and the report its override owes, exercised where
 * they are decidable.
 *
 * These guards used to live inside the two modules that spawn a real CBM
 * executable, and this suite bans both of those by module path -- so five
 * `context-harvest` scenarios rested on code no test could reach, three of them
 * the fail-safe direction. Extracting the decisions made them reachable; this
 * file is what makes them checked.
 *
 * The message fragments are asserted rather than the mere fact of a throw. The
 * scenarios are specified in terms of what the operator is told -- that
 * proceeding stops active CBM sessions, that an unknown state is treated as
 * active, which flag overrides it, which token is missing and which release
 * rejected it -- and a refusal that no longer says those things has stopped
 * satisfying them even while it still refuses.
 */

interface ClassifyCase {
  readonly scenario: string;
  /** What `daemon status` printed, stdout and stderr concatenated. */
  readonly reported: string;
  readonly expected: DaemonState;
}

const classifyCases: ClassifyCase[] = [
  {
    scenario: "the not-running line reads as inactive",
    reported: "daemon: not running\n",
    expected: "inactive",
  },
  {
    scenario: "the active line reads as active, session-managed detail and all",
    reported: "daemon: active (session-managed)\npid: 23048\nclients: 8 committed\n",
    expected: "active",
  },
  {
    scenario: "output that says neither reads as unknown rather than inactive",
    reported: "daemon state: idle\n",
    expected: "unknown",
  },
  {
    scenario: "no output at all reads as unknown rather than inactive",
    reported: "",
    expected: "unknown",
  },
];

test.each(classifyCases)("$scenario", ({ reported, expected }) => {
  expect(classifyDaemonStatus(reported)).toBe(expected);
});

interface RefusalCase {
  readonly scenario: string;
  readonly state: DaemonState;
  readonly stopSessions: boolean;
  /**
   * Fragments the refusal must carry, or `null` when the harvest may proceed.
   */
  readonly refuses: readonly string[] | null;
}

const refusalCases: RefusalCase[] = [
  {
    scenario: "an active daemon refuses, naming the consequence and the override",
    state: "active",
    stopSessions: false,
    refuses: ["a CBM daemon is active", "stop every CBM session on this machine", OVERRIDE_FLAG],
  },
  {
    scenario: "an inactive daemon proceeds without an override",
    state: "inactive",
    stopSessions: false,
    refuses: null,
  },
  {
    scenario: "an unknown state refuses, saying it is treated as active",
    state: "unknown",
    stopSessions: false,
    refuses: ["could not be determined", "treated as active", OVERRIDE_FLAG],
  },
  {
    scenario: "the override proceeds against an active daemon",
    state: "active",
    stopSessions: true,
    refuses: null,
  },
  {
    scenario: "the override proceeds against an unknown state too, since unknown is treated as active",
    state: "unknown",
    stopSessions: true,
    refuses: null,
  },
  {
    scenario: "the override changes nothing when no daemon is active",
    state: "inactive",
    stopSessions: true,
    refuses: null,
  },
];

test.each(refusalCases)("$scenario", ({ state, stopSessions, refuses }) => {
  const refusal = daemonRefusal(state, stopSessions);
  if (refuses === null) {
    expect(refusal).toBeNull();
    return;
  }
  expect(refusal).not.toBeNull();
  for (const fragment of refuses) expect(refusal).toContain(fragment);
});

interface ReportCase {
  readonly scenario: string;
  readonly state: DaemonState;
  /** Fragments the report must carry, or `null` when there is nothing to report. */
  readonly reports: readonly string[] | null;
}

/**
 * The report an override owes the operator.
 *
 * `context-harvest` "Harvest refuses to run while a CBM daemon is active" asks
 * the override to proceed *and* to report that active sessions were stopped.
 * The second half was implemented only as a `console.warn` inside the harvest
 * entry point, which this suite bans by path because it top-level-awaits a real
 * executable -- so half the scenario rested on a string no test could read.
 *
 * The fragments are the claim the scenario is written in terms of: which flag
 * was given, which state was actually seen, and what the run therefore does to
 * this machine's CBM sessions. Asserting merely that something non-null came
 * back would leave the wording free to stop saying any of it.
 */
const reportCases: ReportCase[] = [
  {
    scenario: "overriding an active daemon reports the flag, the state, and what the run stops",
    state: "active",
    reports: [
      OVERRIDE_FLAG,
      "`daemon status` reported active",
      "stops every active CBM session on this machine",
      "editors are holding",
    ],
  },
  {
    scenario: "overriding an unknown state names the state that was seen rather than calling it active",
    state: "unknown",
    reports: [OVERRIDE_FLAG, "`daemon status` reported unknown", "stops every active CBM session on this machine"],
  },
  {
    scenario: "an inactive daemon has nothing to report, because nothing was overridden",
    state: "inactive",
    reports: null,
  },
];

test.each(reportCases)("$scenario", ({ state, reports }) => {
  const report = overrideReport(state);
  if (reports === null) {
    expect(report).toBeNull();
    return;
  }
  expect(report).not.toBeNull();
  for (const fragment of reports) expect(report).toContain(fragment);
});

test("the override flag the refusals name is the one the entry point accepts", () => {
  // Pinned rather than inferred: the refusal tells the operator to pass a
  // literal string, and a rename that missed either side would print advice
  // that does not work.
  expect(OVERRIDE_FLAG).toBe("--stop-sessions");
});

describe("the source-client vocabulary check", () => {
  const VERSION = "codebase-memory-mcp 0.10.8";

  test("passes when the executable accepts every required token", () => {
    expect(() => requireClients(new Set(["claude", "augment", "cursor"]), ["claude", "augment"], VERSION)).not.toThrow();
  });

  test("names the missing token and the version that rejected it", () => {
    const refuse = (): void => requireClients(new Set(["claude", "cursor"]), ["claude", "augment"], VERSION);

    expect(refuse).toThrow(HarvestError);
    // Both halves of the scenario: which token, and which release. Either alone
    // sends a contributor to the wrong repair -- "fix the pipeline" rather than
    // "harvest from a different CBM".
    expect(refuse).toThrow("`augment`");
    expect(refuse).toThrow("0.10.8");
  });

  test("names every missing token, not just the first", () => {
    const refuse = (): void => requireClients(new Set(["cursor"]), ["claude", "augment"], VERSION);

    expect(refuse).toThrow("`claude`");
    expect(refuse).toThrow("`augment`");
  });

  test("reports what the executable does accept, so the next choice is informed", () => {
    const refuse = (): void => requireClients(new Set(["cursor", "claude"]), ["augment"], VERSION);

    expect(refuse).toThrow("it accepts claude, cursor");
  });
});

test("every guard case names a distinct scenario", () => {
  const scenarios = [...classifyCases, ...refusalCases, ...reportCases].map((kase) => kase.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

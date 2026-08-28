import { HarvestError } from "./transform.ts";

/**
 * The refusals that decide whether the harvest may run at all.
 *
 * Everything here is a pure function of what was observed; nothing here
 * observes anything. That split is not tidiness. The two modules that do the
 * observing -- `collect.ts` and `vocabulary.ts` -- spawn a real CBM executable,
 * and the unit suite bans both by module path for exactly that reason
 * (`test/unit/suite-isolation.test.ts`). A guard left inside either of them is
 * a guard no unit test can reach, which is what these were: five
 * `context-harvest` scenarios rested on them and three of those are the
 * fail-safe direction, where an untested guard is worth nothing.
 *
 * So the decisions live here, the executable stays over there, and both
 * side-effecting modules import from this file rather than owning a copy.
 */

/** Whether a CBM daemon is running, or that the question could not be answered. */
export type DaemonState = "active" | "inactive" | "unknown";

/** The line `daemon status` prints when nothing is running. */
const NOT_RUNNING = "daemon: not running";

/** The line `daemon status` prints when something is. */
const RUNNING = "daemon: active";

/**
 * What `daemon status` reported, read out of its combined output.
 *
 * Anything that is not an explicit "not running" is {@link DaemonState}
 * `unknown` rather than inactive, so a changed output shape cannot be read as
 * permission to stop the operator's sessions.
 */
export function classifyDaemonStatus(reported: string): DaemonState {
  if (reported.includes(NOT_RUNNING)) return "inactive";
  if (reported.includes(RUNNING)) return "active";
  return "unknown";
}

/** The flag that overrides the daemon refusal, named in the refusal itself. */
export const OVERRIDE_FLAG = "--stop-sessions";

/**
 * The refusal a daemon state earns, or `null` when the harvest may proceed.
 *
 * The refusal is the default and proceeding must be asked for, because the
 * consequence lands outside this repository: a contributor running the harvest
 * would close whatever CBM sessions their editors currently hold, as a side
 * effect of regenerating documentation.
 *
 * `stopSessions` is a parameter rather than a check at the call site because it
 * is half of the same decision: the refusal names the flag, so the flag has to
 * be answerable in the same place, and the caller then has one thing to obey
 * instead of two things to combine correctly. It clears an unknown state as
 * well as an active one -- an unknown state is treated as active, and the
 * override accepts an active one.
 */
export function daemonRefusal(state: DaemonState, stopSessions: boolean): string | null {
  if (stopSessions) return null;
  switch (state) {
    case "inactive":
      return null;
    case "active":
      return (
        "a CBM daemon is active, and `install` drains active CBM sessions before configuring, so running the " +
        `harvest now would stop every CBM session on this machine. Close them, or pass ${OVERRIDE_FLAG} to accept it.`
      );
    case "unknown":
      return (
        "the CBM daemon status could not be determined, which is treated as active: `install` drains active CBM " +
        `sessions before configuring. Pass ${OVERRIDE_FLAG} to proceed anyway.`
      );
  }
}

/**
 * What the operator is told when an override carries the harvest past a daemon
 * the refusal would otherwise have stopped, or `null` when nothing was
 * overridden.
 *
 * The other half of `context-harvest` "Harvest refuses to run while a CBM
 * daemon is active": the override scenario asks the pipeline to proceed *and*
 * report the consequence, so the report is as much of the requirement as the
 * proceeding is. It lives here rather than at the call site for the reason
 * everything else in this file does -- the entry point is a top-level `await`
 * over a real executable and the unit suite bans it by path, so a message
 * written inline there is a message no test can read.
 *
 * Only the state is taken, because reaching a non-inactive state past
 * {@link daemonRefusal} already implies the override was given: the report
 * cannot claim something that did not happen. An unknown state is reported the
 * same way an active one is, since the refusal it overrode treated it as
 * active. The voice is prospective because the line is printed before `install`
 * runs, and `install` is what does the draining.
 */
export function overrideReport(state: DaemonState): string | null {
  if (state === "inactive") return null;
  return (
    `${OVERRIDE_FLAG} was given and \`daemon status\` reported ${state}, so this run stops every active CBM ` +
    "session on this machine, including the ones editors are holding."
  );
}

/**
 * Refuses unless every required source client is in `vocabulary`.
 *
 * `version` is named in the refusal because the token is not wrong in general,
 * only absent from this release, and that is the difference between "fix the
 * pipeline" and "harvest from a different CBM".
 */
export function requireClients(vocabulary: ReadonlySet<string>, required: readonly string[], version: string): void {
  const missing = required.filter((token) => !vocabulary.has(token));
  if (missing.length === 0) return;
  throw new HarvestError(
    `${version} does not accept \`--clients\` token(s) ${missing.map((token) => `\`${token}\``).join(", ")}; ` +
      `it accepts ${[...vocabulary].sort().join(", ")}`,
  );
}

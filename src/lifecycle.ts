import { rm } from "node:fs/promises";

import { acquire, normalizeVersion, type Acquired } from "./acquire.ts";
import { agentDir, insideManagedBinRoot, packageRoot, type Host } from "./paths.ts";
import { entryStatus, removeEntry, upsertEntry } from "./mcp-config.ts";
import { resolvedVersion, managedCopy, resolveExecutable, type Resolved } from "./resolve.ts";
import { readState, updateState, writeState, type State } from "./state.ts";
import type { ReleaseSource } from "./release.ts";
import type { Target } from "./platform.ts";

/**
 * The operator-visible lifecycle, composed from the layers below it.
 *
 * Everything here is a decision an operator can name: what resolves, what gets
 * downloaded, what the MCP entry says, what a pin holds. No function here
 * touches a UI -- each returns a message and, where a caller needs to branch, a
 * discriminant -- so the same operation is reachable from a slash command, from
 * session start, and from a test with no terminal at all.
 */

/** What every lifecycle operation needs to reach the outside world. */
export interface Lifecycle {
  readonly host: Host;
  readonly target: Target;
  readonly source: ReleaseSource;
}

/**
 * How long a recorded check suppresses the next one.
 *
 * The check exists to tell an operator a newer release is out; it does not need
 * to be fresh to the minute, and a session-start network request per session is
 * a cost with no matching benefit.
 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Everything `/cbm status` reports. */
export interface StatusReport {
  readonly lines: readonly string[];
  readonly resolved: Resolved | null;
}

/** The outcome of one lifecycle action, ready to show an operator. */
export interface ActionReport {
  readonly ok: boolean;
  readonly message: string;
}

/** What session start did about the owned entry. */
export interface SyncReport {
  readonly kind: "unchanged" | "wired" | "rewired" | "unresolved" | "refused";
  readonly message: string;
}

/** What one rate-limited upstream check established. */
export interface CheckReport {
  readonly kind: "skipped" | "current" | "newer" | "failed";
  readonly message: string;
}

/**
 * The full resolution, with everything an operator needs to reason about it.
 *
 * A managed copy is reported even when it is not the resolved one, because
 * "system wins over managed" is a policy whose consequences should never be
 * invisible: an operator with both should be able to see both.
 */
export async function status(lifecycle: Lifecycle): Promise<StatusReport> {
  const { host } = lifecycle;
  const state = await readState(host);
  const resolution = await resolveExecutable(host, state);
  const resolved = resolution.ok ? resolution.resolved : null;

  const lines: string[] = [];
  if (!resolution.ok) {
    lines.push(`executable: none (${resolution.reason})`);
  } else {
    const version = (await resolvedVersion(resolution.resolved)) ?? "unknown (it did not run)";
    lines.push(`executable: ${resolution.resolved.executable}`);
    lines.push(`source:     ${resolution.resolved.source} (${resolution.resolved.origin})`);
    lines.push(`version:    ${version}`);
  }

  const managed = await managedCopy(host, state);
  lines.push(
    managed === null
      ? "managed:    none under this package's root"
      : `managed:    ${managed.version} at ${managed.executable}` +
          (resolved?.executable === managed.executable ? "" : " (present, not resolved)"),
  );

  lines.push(`upstream:   ${state.upstreamVersion ?? "not checked yet"}`);
  lines.push(`pin:        ${state.pin ?? "none"}`);
  lines.push(`agent dir:  ${agentDir(host)}`);

  const entry = await entryStatus(host, resolved?.executable ?? null);
  if (entry.problem !== undefined) {
    lines.push(`mcp entry:  unreadable -- ${entry.problem}`);
  } else if (!entry.present) {
    lines.push(`mcp entry:  absent from ${entry.path}`);
  } else {
    lines.push(
      `mcp entry:  ${entry.current ? "current" : `stale, names ${entry.command ?? "(no command)"}`} in ${entry.path}`,
    );
  }

  return { lines, resolved };
}

/**
 * How a lifecycle operation asks the operator a yes/no question.
 *
 * An interface rather than a direct `ctx.ui.confirm` call so the decision that
 * needs the answer lives here, under test, instead of in the extension entry
 * where the only way to reach it is a real session. `available` is `ctx.hasUI`:
 * when there is no interactive UI the operation must report why and stop, never
 * block on an answer that cannot arrive.
 */
export interface Confirmer {
  readonly available: boolean;
  ask(title: string, message: string): Promise<boolean>;
}

/**
 * The hazard `/cbm install` must explain before a second executable exists.
 *
 * CBM resolves one canonical per-account cache root and refuses to run when a
 * process is configured with a different root while another CBM session is
 * active, so two executables of different versions produce mismatched index
 * generations. An operator who already has a working installation should learn
 * that before the second one exists, not after.
 */
export async function installHazard(lifecycle: Lifecycle): Promise<string | null> {
  const resolution = await resolveExecutable(lifecycle.host, await readState(lifecycle.host));
  if (!resolution.ok || resolution.resolved.source !== "system") return null;

  return (
    `${resolution.resolved.executable} already resolves (${resolution.resolved.origin}). ` +
    "CBM resolves one canonical cache root per account and refuses to run when a process is " +
    "configured with a different root while another CBM session is active, so a second executable " +
    "of a different version produces mismatched index generations. Adopting the installation you " +
    "already have is the safe default."
  );
}

/**
 * `install`, gated on explicit confirmation when a system copy already resolves.
 *
 * With no interactive UI this reports the hazard and downloads nothing rather
 * than waiting: no command here may block on input that cannot arrive.
 */
export async function confirmedInstall(
  lifecycle: Lifecycle,
  version: string | undefined,
  confirmer: Confirmer,
): Promise<ActionReport> {
  const hazard = await installHazard(lifecycle);
  if (hazard === null) return await install(lifecycle, version);

  if (!confirmer.available) {
    return {
      ok: false,
      message: `${hazard} This session has no interactive UI, so the confirmation this needs cannot be asked; nothing was downloaded.`,
    };
  }

  const confirmed = await confirmer.ask("Install a second codebase-memory-mcp?", hazard);
  return confirmed
    ? await install(lifecycle, version)
    : { ok: true, message: `${hazard} Nothing was downloaded.` };
}

/**
 * Acquires a version, adopts it, and points the MCP entry at it.
 *
 * The pointer is only advanced once the copy is on disk, and resolution is then
 * re-run rather than assumed: the adopted path is only correct if it is what
 * resolution actually returns, and a system executable appearing on `PATH`
 * between the download and the pointer update legitimately changes that answer.
 */
export async function install(lifecycle: Lifecycle, version?: string): Promise<ActionReport> {
  const { host } = lifecycle;
  let acquired: Acquired;
  try {
    acquired = await acquire({
      host,
      target: lifecycle.target,
      source: lifecycle.source,
      ...(version === undefined ? {} : { version: normalizeVersion(version) }),
    });
  } catch (error) {
    return { ok: false, message: `install failed: ${describe(error)}` };
  }

  // `acquire` returns the version it was asked for, so an explicitly requested
  // one is no answer about upstream: recording it would report an old build as
  // the newest release and suppress the real check for a day. Only a check --
  // or an install that had to ask what the newest release is -- establishes it.
  const state = await updateState(host, {
    managedVersion: acquired.version,
    managedDigest: acquired.digest,
    ...(version === undefined
      ? { upstreamVersion: acquired.version, lastCheckedAt: Date.now() }
      : {}),
  });

  const resolution = await resolveExecutable(host, state);
  if (!resolution.ok) {
    return {
      ok: false,
      message: `adopted ${acquired.version} at ${acquired.executable}, but resolution then found nothing: ${resolution.reason}`,
    };
  }

  const wiring = await wire(lifecycle, resolution.resolved, state);
  const adopted =
    resolution.resolved.executable === acquired.executable
      ? `adopted ${acquired.version} (${acquired.reportedVersion}) at ${acquired.executable}`
      : `adopted ${acquired.version} at ${acquired.executable}, but resolution prefers ` +
        `${resolution.resolved.executable} (${resolution.resolved.source})`;

  return { ok: true, message: `${adopted}. ${wiring.message}` };
}

/**
 * Updates a managed copy, and only reports on an adopted system one.
 *
 * The asymmetry is not caution for its own sake. CBM's own `install`/`update`
 * drains active sessions and performs a transactional target swap; a second
 * writer replacing the same file mid-swap corrupts exactly the thing the
 * transaction exists to protect. So a system installation is CBM's to update,
 * and this package's job is to say so.
 */
export async function update(lifecycle: Lifecycle): Promise<ActionReport> {
  const { host } = lifecycle;
  const state = await readState(host);
  const resolution = await resolveExecutable(host, state);

  if (resolution.ok && resolution.resolved.source === "system") {
    const check = await checkUpstream(lifecycle, { force: true });
    return {
      ok: true,
      message:
        `${resolution.resolved.executable} is a system installation this package adopted, so it is not replaced here. ` +
        `Run \`${resolution.resolved.executable} update\` to update it. ${check.message}`,
    };
  }

  if (state.pin !== undefined) {
    const check = await checkUpstream(lifecycle, { force: true });
    return {
      ok: true,
      message: `version ${state.pin} is pinned, so nothing was adopted. ${check.message} Run /cbm unpin to release it.`,
    };
  }

  return await install(lifecycle);
}

/** Records a pin so update checks report without adopting. */
export async function pin(lifecycle: Lifecycle, version: string): Promise<ActionReport> {
  let normalized: string;
  try {
    normalized = normalizeVersion(version);
  } catch (error) {
    return { ok: false, message: `pin failed: ${describe(error)}` };
  }

  await updateState(lifecycle.host, { pin: normalized });
  const managed = await managedCopy(lifecycle.host);
  const note =
    managed?.version === normalized
      ? "It is already on disk, so resolution will prefer it."
      : `No managed copy of ${normalized} is on disk yet; run \`/cbm install ${normalized}\` to place one.`;
  return { ok: true, message: `pinned version ${normalized}. ${note}` };
}

/** Releases a pin, leaving every managed version on disk. */
export async function unpin(lifecycle: Lifecycle): Promise<ActionReport> {
  const state = await readState(lifecycle.host);
  if (state.pin === undefined) return { ok: true, message: "no version was pinned." };

  // Whole-document write, not a merge: a merge can only add or replace a key,
  // so releasing a pin has to replace the document that held it.
  const { pin: _released, ...remaining } = state;
  await writeState(lifecycle.host, remaining);
  return { ok: true, message: `released the pin on version ${state.pin}.` };
}

/**
 * Removes what this package placed, and nothing else.
 *
 * The entry goes first, because taking it back needs the state that the second
 * step deletes. An adopted system executable, CBM's cache, and every other MCP
 * server in the file are left exactly as they were.
 */
export async function uninstall(lifecycle: Lifecycle): Promise<ActionReport> {
  const { host } = lifecycle;
  const state = await readState(host);

  const removal = await removeEntry(host, state.wroteCommand);
  if (!removal.ok && (await wouldDangle(host))) {
    // Only a refusal whose entry names something this command is about to
    // delete makes deleting it harmful: OMP would spawn the removed path at
    // every session start, and the same `rm` takes the state that says the
    // entry was ever this package's, so the key could never be reclaimed
    // either. Keeping both halves is recoverable; keeping only the entry is not.
    return {
      ok: false,
      message:
        `left the MCP entry alone: ${removal.reason} The managed copy and this package's state were ` +
        "kept with it, so nothing is left naming a file this command deleted. Resolve that, then run " +
        "/cbm uninstall again.",
    };
  }

  const entryMessage = removal.ok
    ? removal.change === "removed"
      ? "removed the owned MCP entry"
      : "there was no owned MCP entry to remove"
    : `left the MCP entry alone: ${removal.reason}`;

  const root = packageRoot(host);
  const managed = await managedCopy(host, state);
  await rm(root, { recursive: true, force: true });

  const copyMessage =
    managed === null
      ? "no managed copy was present"
      : `removed the managed copy of ${managed.version}`;
  const systemNote = await systemStillPresent(host);

  return { ok: true, message: `${copyMessage}, ${entryMessage}, and deleted ${root}.${systemNote}` };
}

/**
 * Verifies the owned entry against what resolution returns now, and corrects it.
 *
 * Correction is required rather than optional because the resolved path
 * legitimately changes underneath a written entry: a managed update moves it to
 * a new version directory, a system executable appearing on `PATH` is preferred
 * over a managed copy, and a profile change moves the file being written.
 */
export async function syncEntry(lifecycle: Lifecycle): Promise<SyncReport> {
  const { host } = lifecycle;
  const state = await readState(host);
  const resolution = await resolveExecutable(host, state);

  if (!resolution.ok) {
    return {
      kind: "unresolved",
      message: `${resolution.reason} No MCP entry was written or changed.`,
    };
  }

  const before = await entryStatus(host, resolution.resolved.executable);
  const outcome = await wire(lifecycle, resolution.resolved, state);
  if (!outcome.ok) return { kind: "refused", message: outcome.message };

  if (!before.present) return { kind: "wired", message: outcome.message };
  return before.current
    ? { kind: "unchanged", message: outcome.message }
    : { kind: "rewired", message: outcome.message };
}

/**
 * Asks upstream what the newest release is, at most once per day.
 *
 * A failure is not propagated. The check is a convenience; a session that
 * starts without knowing whether a newer version exists is fully functional,
 * and a network that is down must not make it less so.
 *
 * The attempt time is recorded even when the request failed, so a host with no
 * route to GitHub tries once a day rather than once a session.
 */
export async function checkUpstream(
  lifecycle: Lifecycle,
  options: { readonly force?: boolean; readonly now?: number } = {},
): Promise<CheckReport> {
  const { host } = lifecycle;
  const now = options.now ?? Date.now();
  const state = await readState(host);

  // Bounded on both sides, because a recorded time in the future is not "under
  // 24 hours old": a backwards clock correction -- a restored VM snapshot, an
  // NTP step, a host that booted with a bad RTC -- makes the age negative, and a
  // one-sided test would then suppress the daily check for the whole skew and
  // report a negative age to the operator.
  const age = state.lastCheckedAt === undefined ? undefined : now - state.lastCheckedAt;
  if (options.force !== true && age !== undefined && age >= 0 && age < CHECK_INTERVAL_MS) {
    return {
      kind: "skipped",
      message: `upstream was last checked ${Math.round(age / 60_000)} minutes ago; skipping.`,
    };
  }

  let upstream: string;
  try {
    upstream = normalizeVersion(await lifecycle.source.latestTag());
  } catch (error) {
    await updateState(host, { lastCheckedAt: now });
    return { kind: "failed", message: `upstream version check failed: ${describe(error)}` };
  }

  const next = await updateState(host, { upstreamVersion: upstream, lastCheckedAt: now });
  const resolution = await resolveExecutable(host, next);
  const local = resolution.ok ? await resolvedVersion(resolution.resolved) : null;

  if (local !== null && local.includes(upstream)) {
    return { kind: "current", message: `upstream ${upstream} matches the local executable.` };
  }

  const remedy = !resolution.ok
    ? "Run /cbm install to place a managed copy."
    : next.pin !== undefined
      ? `Version ${next.pin} is pinned, so nothing will be adopted. Run /cbm unpin to release it.`
      : resolution.resolved.source === "system"
        ? `Run \`${resolution.resolved.executable} update\` to update the system installation.`
        : "Run /cbm update to adopt it.";

  return {
    kind: "newer",
    message: `upstream release is ${upstream}; local is ${local ?? "unknown"}. ${remedy}`,
  };
}

/**
 * Writes the owned entry for `resolved` and records what was written.
 *
 * The recorded `command` is what makes the entry decidably ours on a later run,
 * including after the resolved path has moved -- which is exactly when an
 * ownership test based on the current resolution alone would refuse to correct
 * its own entry.
 */
async function wire(
  lifecycle: Lifecycle,
  resolved: Resolved,
  state: State,
): Promise<ActionReport> {
  const outcome = await upsertEntry(lifecycle.host, resolved.executable, state.wroteCommand);
  if (!outcome.ok) return { ok: false, message: outcome.reason };

  if (state.wroteCommand !== resolved.executable) {
    await updateState(lifecycle.host, { wroteCommand: resolved.executable });
  }

  switch (outcome.change) {
    case "created":
      return { ok: true, message: `Wrote the MCP entry naming ${resolved.executable}.` };
    case "updated":
      return {
        ok: true,
        message: `Corrected the MCP entry to ${resolved.executable}; run /mcp reload so this session picks it up.`,
      };
    case "unchanged":
      return { ok: true, message: `The MCP entry already names ${resolved.executable}.` };
  }
}

/**
 * Whether removing the package-owned root would leave the owned entry naming a
 * file that no longer exists.
 *
 * Asked only when {@link removeEntry} refused, and it is what separates the two
 * kinds of refusal. An entry inside the managed bin root -- or a file this
 * package could not read structurally, where it cannot know what the entry
 * names -- is the dangerous kind. An entry naming a system CBM is not: that
 * entry is correctly wired to an executable uninstall never touches, so
 * blocking on it would make the managed copy unremovable by the one command
 * whose job is removing it.
 *
 * The managed-root half is unreachable through {@link removeEntry} as it stands:
 * ownership there is decided from the path as well as from recorded state, so a
 * readable entry naming something under the managed root is this package's and
 * is removed rather than refused. Every refusal that reaches here today is a
 * file-level one and answers on `problem`.
 *
 * It is kept anyway, because this predicate states the property it is named for
 * rather than a fact about how `removeEntry` currently decides ownership.
 * Dropping it would make uninstall's safety depend on an invariant that lives in
 * another function, and a later narrowing of that ownership rule would silently
 * reintroduce the dangling entry this guard exists to prevent -- a failure whose
 * cost is a deleted executable OMP keeps spawning and a key that can never be
 * reclaimed. There is deliberately no test reaching this half: one could only be
 * written by contriving a refusal `removeEntry` does not produce, which would
 * assert the scaffolding rather than the property.
 */
async function wouldDangle(host: Host): Promise<boolean> {
  const entry = await entryStatus(host, null);
  if (entry.problem !== undefined) return true;
  return entry.command !== undefined && insideManagedBinRoot(host, entry.command);
}

/** A note naming an adopted system executable uninstall deliberately left alone. */
async function systemStillPresent(host: Host): Promise<string> {
  const resolution = await resolveExecutable(host, {});
  return resolution.ok && resolution.resolved.source === "system"
    ? ` The system installation at ${resolution.resolved.executable} was left in place.`
    : "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

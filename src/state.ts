import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { statePath, type Host } from "./paths.ts";

/**
 * This package's own state, outside the plugin tree because the managed
 * executable it describes outlives a plugin reinstall.
 *
 * Every field is optional and every read tolerates a missing or unreadable
 * file. State here is a cache and a record of operator intent, never a
 * prerequisite: resolution works from an empty state, and the worst a lost
 * state file costs is one extra version check and a forgotten pin.
 */
export interface State {
  /** The managed version the current pointer names, when one was adopted. */
  readonly managedVersion?: string;
  /** The archive digest that version was verified against. */
  readonly managedDigest?: string;
  /** A version the operator pinned; update checks report but never adopt. */
  readonly pin?: string;
  /** The newest upstream version the last successful check saw. */
  readonly upstreamVersion?: string;
  /** When the last upstream check completed, successfully or not, in epoch ms. */
  readonly lastCheckedAt?: number;
  /** The absolute `command` this package last wrote into `mcp.json`. */
  readonly wroteCommand?: string;
}

const EMPTY: State = {};

/**
 * The recorded state, or an empty state.
 *
 * A missing file is the first-run case. An unparseable one is treated the same
 * way rather than refused: the file is this package's own cache, so the
 * recoverable reading is "forget what was cached", and failing a session start
 * over a corrupted cache entry would be a worse outcome than re-checking.
 */
export async function readState(host: Host): Promise<State> {
  const file = Bun.file(statePath(host));
  let text: string;
  try {
    text = await file.text();
  } catch {
    return EMPTY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY;

  const record = parsed as Record<string, unknown>;
  const state: Record<string, unknown> = {};
  for (const key of ["managedVersion", "managedDigest", "pin", "upstreamVersion", "wroteCommand"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") state[key] = value;
  }
  const lastCheckedAt = record["lastCheckedAt"];
  if (typeof lastCheckedAt === "number" && Number.isFinite(lastCheckedAt)) {
    state["lastCheckedAt"] = lastCheckedAt;
  }
  return state as State;
}

/**
 * Replaces the recorded state with `next`.
 *
 * Whole-document rather than field-wise because the document is small and one
 * writer owns it; a partial update would need a lock this package does not
 * have. Callers read, spread, and write.
 *
 * Staged beside the file and renamed in, rather than truncated in place: a
 * write interrupted by a crash or a `SIGKILL` at shutdown leaves a document
 * that no longer parses, and this file degrades silently -- the reader above
 * falls back to the empty state, which forgets the operator's pin and the
 * `wroteCommand` that decides whether the MCP entry is this package's to take
 * back. `rename` within one directory is atomic, so a reader sees either the
 * old document or the new one. The staging name carries the pid and a random
 * suffix so two writers never share it.
 *
 * The destination's own mode is reproduced before the rename, because `rename`
 * replaces the destination rather than truncating it and the visible file would
 * otherwise inherit the staging file's default. Nothing recorded here is a
 * secret, but a package-private cache is not the operator's to have widened by a
 * write they did not ask for; a file this write creates gets 0600.
 */
export async function writeState(host: Host, next: State): Promise<void> {
  const file = statePath(host);
  await mkdir(path.dirname(file), { recursive: true });

  const staging = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    let mode = 0o600;
    try {
      mode = (await stat(file)).mode & 0o777;
    } catch (error) {
      const code = (error as { code?: string } | null | undefined)?.code;
      if (code !== "ENOENT") throw error;
    }

    await Bun.write(staging, `${JSON.stringify(next, null, 2)}\n`);
    await chmod(staging, mode);
    await rename(staging, file);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

/** Merges `patch` into the recorded state and writes the result. */
export async function updateState(host: Host, patch: State): Promise<State> {
  const next = { ...(await readState(host)), ...patch };
  await writeState(host, next);
  return next;
}

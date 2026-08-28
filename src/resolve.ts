import { readVersion } from "./exec.ts";
import {
  EXECUTABLE_NAME,
  managedBinRoot,
  managedExecutable,
  upstreamInstallDir,
  type Host,
} from "./paths.ts";
import { readState, type State } from "./state.ts";

import path from "node:path";

/**
 * Which of the four places an executable was found.
 *
 * `system` covers both `PATH` and `~/.local/bin`: they are the same policy
 * decision -- an installation this package did not place and must not touch --
 * and {@link Resolved.origin} names which one it was for the status report.
 */
export type ResolutionSource = "pin" | "system" | "managed";

export interface Resolved {
  /** Absolute path to the executable. */
  readonly executable: string;
  readonly source: ResolutionSource;
  /** Where it was found, for the status report: `PATH`, `~/.local/bin`, a version. */
  readonly origin: string;
}

/** A managed copy on disk, whether or not it is the resolved one. */
export interface ManagedCopy {
  readonly version: string;
  readonly executable: string;
}

export type Resolution =
  | { readonly ok: true; readonly resolved: Resolved }
  | { readonly ok: false; readonly reason: string };

/**
 * The remedy an unresolved lookup names.
 *
 * Both paths are offered because they lead to different outcomes and the
 * operator owns the choice: `/cbm install` places a copy this package manages
 * and can update, upstream's installer places one at `~/.local/bin` that CBM's
 * own `update` owns. This package adopts either.
 */
const NO_EXECUTABLE_REASON =
  `no ${EXECUTABLE_NAME} executable found on PATH, in ~/.local/bin, or under this package's own root. ` +
  "Run /cbm install to download a managed copy, or install it yourself with " +
  "`curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash` " +
  "and this package will adopt it.";

/**
 * The managed copy the state's pointer names, when it is still on disk.
 *
 * The pointer is a field of the state file rather than a separate symlink or
 * `current` file. One document means one write to keep consistent, and it
 * sidesteps the question of what a symlink means on a platform this package
 * will eventually support.
 */
export async function managedCopy(host: Host, state?: State): Promise<ManagedCopy | null> {
  const recorded = (state ?? (await readState(host))).managedVersion;
  if (recorded === undefined) return null;

  const executable = managedExecutable(host, recorded);
  return (await Bun.file(executable).exists()) ? { version: recorded, executable } : null;
}

/**
 * The executable this package will point the MCP entry at.
 *
 * Order is pin, `PATH`, `~/.local/bin`, managed copy -- system before managed,
 * deliberately, and the reason is the index rather than tidiness. CBM resolves
 * one canonical per-account cache root and refuses to run when a process is
 * configured with a different root while any CBM session or command is active.
 * Two executables of different versions sharing that root produce mismatched
 * index generations, so adopting whatever the operator already runs is the only
 * safe default. A private cache root for the managed copy would avoid the
 * conflict by re-indexing every repository a second time, which for a large
 * tree is hours of work to hold the same answers twice.
 *
 * A pin comes first because it is explicit operator intent, and it can only
 * ever select a managed copy -- this package does not relocate or re-version a
 * system installation.
 */
export async function resolveExecutable(host: Host, state?: State): Promise<Resolution> {
  const current = state ?? (await readState(host));

  const pin = current.pin;
  if (pin !== undefined) {
    const pinned = managedExecutable(host, pin);
    if (await Bun.file(pinned).exists()) {
      return { ok: true, resolved: { executable: pinned, source: "pin", origin: pin } };
    }
  }

  const onPath = Bun.which(EXECUTABLE_NAME, pathOption(host));
  if (onPath !== null) {
    return {
      ok: true,
      resolved: { executable: path.resolve(onPath), source: "system", origin: "PATH" },
    };
  }

  const upstream = path.join(upstreamInstallDir(host), EXECUTABLE_NAME);
  if (await Bun.file(upstream).exists()) {
    return {
      ok: true,
      resolved: { executable: upstream, source: "system", origin: "~/.local/bin" },
    };
  }

  const managed = await managedCopy(host, current);
  if (managed !== null) {
    return {
      ok: true,
      resolved: {
        executable: managed.executable,
        source: "managed",
        origin: path.join(path.basename(managedBinRoot(host)), managed.version),
      },
    };
  }

  return { ok: false, reason: NO_EXECUTABLE_REASON };
}

/** The version the resolved executable reports, or `null` when it will not run. */
export async function resolvedVersion(resolved: Resolved): Promise<string | null> {
  return await readVersion(resolved.executable);
}

/**
 * `Bun.which`'s options for this host.
 *
 * Threaded from {@link Host} rather than read from `process.env` so a test can
 * point `PATH` at a scratch directory; `Bun.which` falls back to the process
 * environment when no `PATH` is supplied, which would make such a test read the
 * developer's own installation.
 */
function pathOption(host: Host): { PATH: string } {
  return { PATH: host.env["PATH"] ?? "" };
}

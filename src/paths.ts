import { homedir } from "node:os";
import path from "node:path";

/**
 * Where this package reads and writes, and how it decides.
 *
 * Every path is derived from an explicit {@link Host} rather than from ambient
 * `process.env` and `os.homedir()`, so a test can run the whole lifecycle
 * against a scratch `HOME` and then assert what was *not* written -- which is
 * the only way to prove `~/.local/bin` is left alone.
 */

/** The ambient facts every path derives from. */
export interface Host {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The real host: this process's home directory and environment. */
export function processHost(): Host {
  return { home: homedir(), env: process.env };
}

/** The executable's name on PATH and inside the release archive. */
export const EXECUTABLE_NAME = "codebase-memory-mcp";

/** The MCP server key this package owns, and nothing else in the file. */
export const SERVER_NAME = "codebase-memory-mcp";

/**
 * OMP's config directory name, `PI_CONFIG_DIR` included.
 *
 * Honoured because every path below hangs off it: a process started with
 * `PI_CONFIG_DIR` set writes its agent configuration somewhere else entirely,
 * and an entry written to `~/.omp/agent/mcp.json` would be read by nobody.
 */
function configDirName(host: Host): string {
  const override = host.env["PI_CONFIG_DIR"];
  return override !== undefined && override !== "" ? override : ".omp";
}

/**
 * The active OMP agent directory, resolved the way OMP resolves it.
 *
 * `PI_CODING_AGENT_DIR` first is not a guess about precedence: OMP's CLI calls
 * `setProfile(...)` on every start -- with the `--profile` value, or with
 * `OMP_PROFILE`/`PI_PROFILE` from the environment -- and a named profile makes
 * that call write `PI_CODING_AGENT_DIR` back as the profile's own agent
 * directory. So inside a session the variable is already OMP's answer, and
 * reading it first reproduces that answer exactly.
 *
 * The profile branch is the fallback for a process that never went through
 * OMP's CLI: `OMP_PROFILE` is canonical and `PI_PROFILE` is consulted only when
 * `OMP_PROFILE` is undefined, which is OMP's own rule -- an explicitly empty
 * `OMP_PROFILE` selects the default profile rather than inheriting the legacy
 * variable.
 */
export function agentDir(host: Host): string {
  const explicit = host.env["PI_CODING_AGENT_DIR"];
  if (explicit !== undefined && explicit !== "") return path.resolve(explicit);

  const omp = host.env["OMP_PROFILE"];
  const profile = omp !== undefined ? omp : host.env["PI_PROFILE"];
  const root = path.join(host.home, configDirName(host));
  return profile !== undefined && profile !== ""
    ? path.join(root, "profiles", profile, "agent")
    : path.join(root, "agent");
}

/** The native user MCP file this package owns one key in. */
export function mcpConfigPath(host: Host): string {
  return path.join(agentDir(host), "mcp.json");
}

/**
 * The path a future upstream `--clients=omp` would write its own extension to.
 *
 * Checked on load so a CBM-written native extension and this package's entry
 * cannot both apply the next change's output augmentation. Extension modules
 * are deduplicated by absolute path, so both would load.
 */
export function nativeExtensionPath(host: Host): string {
  return path.join(agentDir(host), "extensions", "codebase-memory.ts");
}

/**
 * The root this package owns, and the only place it writes an executable.
 *
 * Outside the plugin tree on purpose: OMP caches plugins in version-qualified
 * directories and replaces them on reinstall, so a managed executable stored
 * inside would be discarded by a routine plugin upgrade and re-downloaded every
 * time. Outside the agent directory too, so it survives a profile switch.
 */
export function packageRoot(host: Host): string {
  return path.join(host.home, configDirName(host), "codebase-memory");
}

/** Where managed versions live, one directory per version. */
export function managedBinRoot(host: Host): string {
  return path.join(packageRoot(host), "bin");
}

/** The managed executable for one version. */
export function managedExecutable(host: Host, version: string): string {
  return path.join(managedBinRoot(host), version, EXECUTABLE_NAME);
}

/**
 * Whether `candidate` names a file under {@link managedBinRoot}.
 *
 * The one path predicate that decides ownership: nothing but this package ever
 * writes under that root, so a `command` inside it is decidably this package's
 * own even after the state that recorded it was lost. `path.relative` rather
 * than a `startsWith` on the raw string, because a sibling directory whose name
 * merely shares the prefix -- `bin-backup`, `bin.old` -- passes the string test
 * and is not inside the root; adopting one would be exactly the silent
 * overwrite the ownership test exists to prevent. A relative `command` is never
 * ours: every path this package writes is absolute.
 */
export function insideManagedBinRoot(host: Host, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const inside = path.relative(managedBinRoot(host), candidate);
  return inside !== "" && !inside.startsWith("..") && !path.isAbsolute(inside);
}

/** This package's state file: source, version, digest, pin, last check. */
export function statePath(host: Host): string {
  return path.join(packageRoot(host), "state.json");
}

/**
 * Upstream's own install directory, which this package reads and never writes.
 *
 * Present here so the resolution order can consult it, and so the test that
 * proves it is untouched has one name to check rather than a literal.
 */
export function upstreamInstallDir(host: Host): string {
  return path.join(host.home, ".local", "bin");
}

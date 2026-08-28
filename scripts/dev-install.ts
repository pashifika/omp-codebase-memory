#!/usr/bin/env bun
/**
 * Brings a development checkout to the state a finished install actually has.
 *
 *   bun run dev:install [--no-build] [--no-marketplace] [--no-mcp] [--force]
 *
 * `omp plugin link .` is one of four things a complete install is, and doing
 * only that leaves a half-installed machine: the bundles may be stale against
 * `src/`, the catalog is not registered so `omp plugin discover` and
 * `omp plugin upgrade` have nothing to read, and the owned MCP entry is not
 * written until some later session happens to start. Each of those is a
 * separate command an operator has to remember, so this script is the list.
 *
 * It is not a second implementation of any of them. The plugin registry and the
 * catalog are touched only through OMP's own CLI, and the MCP entry only through
 * this package's own `syncEntry` -- the same call the extension makes at session
 * start, against the same single owned key. No path is derived here: every one
 * comes from `src/paths.ts`, so this script cannot disagree with the extension
 * about where anything lives.
 *
 * What it deliberately does not do:
 *
 * - It never acquires a CBM executable. `/cbm install` asks for confirmation
 *   when a system copy already resolves, and a script that answered that
 *   question for you would be deciding which executable your account's index
 *   belongs to. When nothing resolves, this reports it and names the command.
 * - It never installs from the catalog it registers. That resolves the catalog's
 *   `source.ref`, so it needs a published release; the script says so rather
 *   than failing at it.
 * - It refuses instead of replacing a registration this checkout does not own,
 *   so a git-spec install is never silently swapped for a link.
 */
import { realpath } from "node:fs/promises";

import { run } from "../src/exec.ts";
import { syncEntry, type Lifecycle } from "../src/lifecycle.ts";
import { entryStatus } from "../src/mcp-config.ts";
import { agentDir, processHost, type Host } from "../src/paths.ts";
import { hostTarget, UnsupportedPlatformError } from "../src/platform.ts";
import { githubReleaseSource } from "../src/release.ts";
import { managedCopy, resolveExecutable, resolvedVersion } from "../src/resolve.ts";
import { readState } from "../src/state.ts";

/** The plugin name OMP registers this checkout under, from the manifest. */
const PACKAGE_NAME = "omp-codebase-memory";

/** The catalog this repository publishes itself through, in `owner/repo` form. */
const MARKETPLACE_SOURCE = "pashifika/omp-codebase-memory";

/** Accepted options, so an unknown one fails rather than being ignored. */
const KNOWN_FLAGS: Record<string, true> = {
  "--no-build": true,
  "--no-marketplace": true,
  "--no-mcp": true,
  "--force": true,
};

interface Options {
  readonly build: boolean;
  readonly marketplace: boolean;
  readonly mcp: boolean;
  readonly force: boolean;
}

/**
 * What the catalog says about itself.
 *
 * Both fields are read rather than repeated here: the marketplace name is what
 * `omp plugin marketplace list` prints and what `<plugin>@<marketplace>`
 * addresses, and the ref is what an install from the catalog resolves. A rename
 * in the file would otherwise leave this script looking for a marketplace
 * nobody has, or naming a ref nobody installs.
 */
interface Catalog {
  readonly name: string;
  readonly ref: string;
}

/** One labelled step, so a partial run says where it stopped. */
function step(n: number, title: string): void {
  console.log(`\n=== ${n}. ${title}`);
}

/**
 * One aligned fact under a step.
 *
 * The pad is one short of the column so a label at or past the column width
 * still gets a separator instead of running into its value.
 */
function detail(label: string, value: string): void {
  console.log(`  ${label.padEnd(11)} ${value}`);
}

/**
 * Runs an `omp` subcommand, failing the script on anything but success.
 *
 * Through `run` rather than a second spawn helper: the timeout, the output cap,
 * and the missing-executable answer are already decided there.
 */
async function omp(argv: readonly string[], timeoutMs = 120_000): Promise<string> {
  const result = await run(["omp", ...argv], { timeoutMs });
  if (result.spawnError !== undefined) {
    throw new Error(`omp ${argv.join(" ")}: ${result.spawnError}`);
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  if (!result.ok) {
    throw new Error(`omp ${argv.join(" ")} exited ${result.exitCode}\n${output}`);
  }
  return output;
}

/**
 * Where OMP currently thinks this plugin lives, or `null` when it is unknown.
 *
 * The registry is OMP's, so it is read through OMP: `plugin list --json` reports
 * the resolved path, which for a linked checkout is the symlink under the plugin
 * root. Every group in that document is scanned rather than just `npm`, because
 * which group a plugin lands in is the installer's choice and this question is
 * about the name, not the route.
 */
async function registeredPath(): Promise<string | null> {
  const result = await run(["omp", "plugin", "list", "--json"], { timeoutMs: 60_000 });
  if (result.spawnError !== undefined || !result.ok) return null;

  let listing: unknown;
  try {
    listing = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (typeof listing !== "object" || listing === null) return null;

  for (const group of Object.values(listing)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (typeof entry !== "object" || entry === null) continue;
      if (!("name" in entry) || entry.name !== PACKAGE_NAME) continue;
      return "path" in entry && typeof entry.path === "string" ? entry.path : null;
    }
  }
  return null;
}

/**
 * Reports which optional features will actually load, computed the way OMP does.
 *
 * `omp plugin features <name>` is not quoted here, and the reason is a real trap
 * rather than a formatting preference. Its renderer builds its enabled set from
 * `getEnabledFeatures`, so the `enabledFeatures: null` case -- no explicit
 * selection recorded, which is what a plain install leaves -- yields an empty
 * set and prints the disabled glyph beside every feature, including one whose
 * manifest default is `true` and which the loader does load. A development
 * install that pasted that output would report the augmentation as off while it
 * is demonstrably appending to tool results.
 *
 * The rule reproduced here is `resolvePluginManifestEntries`
 * (`@oh-my-pi/pi-coding-agent`, `extensibility/plugins/loader.ts`): an explicit
 * array selects exactly its members, and `null` selects every feature whose
 * `default` is true.
 */
async function reportFeatures(root: string): Promise<void> {
  const manifest = await Bun.file(`${root}/package.json`).json();
  const features = manifest.omp?.features;
  if (typeof features !== "object" || features === null) {
    console.log("  features    none declared in the manifest");
    return;
  }

  const state = JSON.parse(await omp(["plugin", "features", PACKAGE_NAME, "--json"]));
  const selection: unknown = state.enabledFeatures;
  const explicit = Array.isArray(selection) ? new Set(selection.map(String)) : null;

  for (const [name, feature] of Object.entries(features)) {
    const byDefault =
      typeof feature === "object" && feature !== null && "default" in feature
        ? feature.default === true
        : false;
    const on = explicit === null ? byDefault : explicit.has(name);
    const why =
      explicit === null
        ? `manifest default ${byDefault ? "on" : "off"}, no explicit selection recorded`
        : `explicitly ${explicit.has(name) ? "selected" : "declined"} at install`;
    detail(name, `${on ? "on" : "off"} — ${why}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    if (KNOWN_FLAGS[arg] !== true) throw new Error(`unknown option ${arg}`);
  }
  const options: Options = {
    build: !argv.includes("--no-build"),
    marketplace: !argv.includes("--no-marketplace"),
    mcp: !argv.includes("--no-mcp"),
    force: argv.includes("--force"),
  };

  const root = await realpath(new URL("..", import.meta.url).pathname);
  const host: Host = processHost();
  const document = await Bun.file(`${root}/.omp-plugin/marketplace.json`).json();
  const catalogName = document.name;
  const catalogRef = document.plugins?.[0]?.source?.ref;
  if (typeof catalogName !== "string" || catalogName === "") {
    throw new Error(".omp-plugin/marketplace.json declares no marketplace name");
  }
  const catalog: Catalog = {
    name: catalogName,
    ref: typeof catalogRef === "string" && catalogRef !== "" ? catalogRef : "(none declared)",
  };

  console.log(`development install of ${PACKAGE_NAME}`);
  detail("checkout", root);
  detail("agent dir", agentDir(host));

  step(1, "check what currently owns the plugin name");
  const existing = await registeredPath();
  const existingRoot = existing === null ? null : await realpath(existing).catch(() => existing);
  if (existing === null) {
    console.log("  nothing registered under this name yet");
  } else if (existingRoot === root) {
    console.log(`  already registered from this checkout: ${existing}`);
  } else if (options.force) {
    console.log(`  registered elsewhere (${existing}); --force given, relinking anyway`);
  } else {
    throw new Error(
      `${PACKAGE_NAME} is registered from ${existing}, which is not this checkout.\n` +
        "Replacing it would swap a real install for a link without saying so. Run\n" +
        `  omp plugin uninstall ${PACKAGE_NAME}\n` +
        "first, or pass --force if that is what you meant.",
    );
  }

  step(2, "build both committed bundles");
  if (options.build) {
    const built = await run(["bun", "run", "build"], { cwd: root, timeoutMs: 300_000 });
    if (built.spawnError !== undefined) throw new Error(`bun run build: ${built.spawnError}`);
    if (!built.ok) {
      throw new Error(`bun run build exited ${built.exitCode}\n${built.stdout}${built.stderr}`);
    }
    console.log("  dist/index.js and dist/augment.js rebuilt from src/");
    console.log("  commit the result if it differs; CI compares both byte-for-byte");
  } else {
    console.log("  skipped (--no-build); the committed bundles are used as they are");
  }

  step(3, "register the checkout");
  console.log(`  ${await omp(["plugin", "link", "."])}`);
  const linked = await registeredPath();
  if (linked === null) {
    throw new Error("omp plugin link reported success but the plugin is not registered");
  }
  detail("path", linked);
  await reportFeatures(root);

  step(4, "register the marketplace catalog");
  if (options.marketplace) {
    // Matched on the source rather than the catalog's name: `marketplace list`
    // ignores `--json` and prints `<name>  <source>` per line, and this
    // repository's catalog name and package name are the same string, so a name
    // match would also accept some other marketplace that merely mentions it.
    const listed = await omp(["plugin", "marketplace", "list"]);
    if (listed.includes(MARKETPLACE_SOURCE)) {
      console.log(`  already registered: ${catalog.name}  ${MARKETPLACE_SOURCE}`);
    } else {
      console.log(`  ${await omp(["plugin", "marketplace", "add", MARKETPLACE_SOURCE])}`);
    }
    console.log(
      `  omp plugin discover and omp plugin upgrade read the catalog and work now.\n` +
        `  Installing from it resolves ${catalog.ref}, so that needs a published release;\n` +
        "  until then the git spec is the route that resolves.",
    );
  } else {
    console.log("  skipped (--no-marketplace)");
  }

  step(5, "wire the owned MCP entry");
  let lifecycle: Lifecycle | null = null;
  try {
    lifecycle = { host, target: hostTarget(), source: githubReleaseSource() };
  } catch (error) {
    console.log(
      `  skipped: ${
        error instanceof UnsupportedPlatformError
          ? error.message
          : `platform detection failed: ${error instanceof Error ? error.message : String(error)}`
      }`,
    );
  }
  if (lifecycle === null) {
    // Nothing to wire and nothing to report: the reason is already printed.
  } else if (options.mcp) {
    const sync = await syncEntry(lifecycle);
    console.log(`  ${sync.kind}: ${sync.message}`);
  } else {
    console.log("  skipped (--no-mcp); the next session start writes it");
  }

  step(6, "report what resolves");
  const state = await readState(host);
  const resolution = await resolveExecutable(host, state);
  if (!resolution.ok) {
    detail("executable", `none — ${resolution.reason}`);
  } else {
    detail("executable", resolution.resolved.executable);
    detail("source", `${resolution.resolved.source} (${resolution.resolved.origin})`);
    detail("version", (await resolvedVersion(resolution.resolved)) ?? "unknown (it did not run)");
  }
  const managed = await managedCopy(host, state);
  detail("managed", managed === null ? "none under this package's root" : managed.version);

  const entry = await entryStatus(host, resolution.ok ? resolution.resolved.executable : null);
  detail(
    "mcp entry",
    entry.problem !== undefined
      ? `unreadable — ${entry.problem}`
      : !entry.present
        ? `absent from ${entry.path}`
        : entry.current
          ? `current in ${entry.path}`
          : `stale, names ${entry.command ?? "(no command)"}`,
  );

  console.log(
    "\nWhat remains is not this script's to do:\n" +
      "  - Indexing is the agent's work. Ask it to index this repository; nothing here\n" +
      "    ships an index command.\n" +
      "  - `/cbm status` in a session reports the index half, which needs a CBM process\n" +
      "    this script does not open.",
  );
}

try {
  await main();
} catch (error) {
  console.error(`dev-install: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

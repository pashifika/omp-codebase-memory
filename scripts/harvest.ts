#!/usr/bin/env bun
/**
 * Regenerates the shipped context artifacts from a CBM executable.
 *
 * Run it when the resolved CBM version changes, and read the failure when CI's
 * `harvest` job says the committed tree no longer matches. It is deliberately
 * not part of `test:unit`: it needs an executable and therefore a network, on a
 * machine that may have neither, and every transformation it drives is unit
 * tested against recorded fixtures instead.
 *
 *   bun run harvest [--stop-sessions]
 *
 * `--stop-sessions` accepts that `install` will close every CBM session on this
 * machine. Without it the harvest refuses while a daemon is active, because
 * regenerating documentation should not take an editor's MCP connection with it.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { readVersion } from "../src/exec.ts";
import { collect, OVERRIDE_FLAG, SOURCE_CLIENTS } from "../src/harvest/collect.ts";
import { AGENTS_DIR, HarvestError, transformAgent, transformRule, transformSkill } from "../src/harvest/transform.ts";
import { clientVocabulary, requireClients } from "../src/harvest/vocabulary.ts";
import { processHost } from "../src/paths.ts";
import { resolveExecutable } from "../src/resolve.ts";
import { readState } from "../src/state.ts";

import type { Artifact } from "../src/harvest/transform.ts";

/** The build record: which executable every shipped artifact came from. */
const PROVENANCE_PATH = "harvest.json";

/**
 * Directories the pipeline owns outright.
 *
 * Removed before writing, so an upstream tier that disappears becomes a
 * deletion in the diff rather than a stale file nobody notices.
 */
const OWNED_DIRS = ["skills/codebase-memory", "rules", AGENTS_DIR] as const;

interface Provenance {
  /** The version parsed out of {@link Provenance.reportedVersion}. */
  readonly cbmVersion: string;
  /** Exactly what the executable printed for `--version`. */
  readonly reportedVersion: string;
  /** The `--clients` tokens the emitted content was derived from. */
  readonly sourceClients: readonly string[];
  /** Every path this pipeline writes, so CI can confirm each one is tracked. */
  readonly generated: readonly string[];
}

const root = path.resolve(import.meta.dir, "..");

async function main(argv: readonly string[]): Promise<void> {
  const stopSessions = argv.includes(OVERRIDE_FLAG);
  const unknown = argv.filter((argument) => argument !== OVERRIDE_FLAG);
  if (unknown.length > 0) {
    throw new HarvestError(`unknown argument(s) ${unknown.join(", ")}; the only flag is ${OVERRIDE_FLAG}`);
  }

  const host = processHost();
  const resolution = await resolveExecutable(host, await readState(host));
  if (!resolution.ok) throw new HarvestError(resolution.reason);
  const { executable } = resolution.resolved;

  const reportedVersion = await readVersion(executable);
  if (reportedVersion === null) {
    throw new HarvestError(`${executable} would not report a version, so nothing can be attributed to it`);
  }

  // Verified against the executable rather than assumed: the `--clients`
  // vocabulary differs between releases, and an unknown token makes `install`
  // print the vocabulary and configure nothing.
  requireClients(await clientVocabulary(executable), SOURCE_CLIENTS, reportedVersion);

  const emitted = await collect(executable, { stopSessions });
  const artifacts: Artifact[] = [
    transformSkill(emitted.skill),
    transformRule(emitted.rule),
    ...emitted.agents.map((source) => transformAgent(source)),
  ];

  const provenance: Provenance = {
    cbmVersion: /\b(\d+\.\d+\.\d+\S*)/u.exec(reportedVersion)?.[1] ?? reportedVersion,
    reportedVersion,
    sourceClients: [...SOURCE_CLIENTS],
    generated: [...artifacts.map((artifact) => artifact.path).sort(), PROVENANCE_PATH],
  };

  for (const directory of OWNED_DIRS) {
    await rm(path.join(root, directory), { recursive: true, force: true });
  }
  for (const artifact of artifacts) {
    const file = path.join(root, artifact.path);
    await mkdir(path.dirname(file), { recursive: true });
    await Bun.write(file, artifact.content);
  }
  await Bun.write(path.join(root, PROVENANCE_PATH), `${JSON.stringify(provenance, null, 2)}\n`);

  console.log(`harvested from ${executable} (${reportedVersion})`);
  console.log(`  clients: ${SOURCE_CLIENTS.join(", ")}`);
  for (const file of provenance.generated) console.log(`  wrote ${file}`);
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  console.error(`harvest: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

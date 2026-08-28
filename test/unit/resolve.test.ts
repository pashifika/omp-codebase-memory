import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  EXECUTABLE_NAME,
  managedExecutable,
  upstreamInstallDir,
} from "../../src/paths.ts";
import { managedCopy, resolveExecutable } from "../../src/resolve.ts";
import { writeState } from "../../src/state.ts";
import { dropScratch, makeScratch, writeFakeExecutable, type Scratch } from "../support/scratch.ts";

/**
 * Which copies exist for one case.
 *
 * Written as the world an operator would have -- something on `PATH`, something
 * upstream installed, something this package downloaded -- rather than as the
 * state fields resolution happens to read.
 */
interface Layout {
  /** A copy on the scratch `PATH`, reporting this version. */
  readonly onPath?: string;
  /** A copy at `~/.local/bin`, where upstream's installer puts one. */
  readonly localBin?: string;
  /** A managed copy under this package's root, recorded as the pointer. */
  readonly managed?: string;
  /** A recorded pin. */
  readonly pin?: string;
  /** A recorded pointer with no file behind it, e.g. after a manual delete. */
  readonly danglingPointer?: string;
}

async function place(scratch: Scratch, layout: Layout): Promise<void> {
  if (layout.onPath !== undefined) {
    await writeFakeExecutable(
      path.join(scratch.pathDir, EXECUTABLE_NAME),
      `echo "codebase-memory-mcp ${layout.onPath}"`,
    );
  }
  if (layout.localBin !== undefined) {
    await writeFakeExecutable(
      path.join(upstreamInstallDir(scratch.host), EXECUTABLE_NAME),
      `echo "codebase-memory-mcp ${layout.localBin}"`,
    );
  }
  if (layout.managed !== undefined) {
    await writeFakeExecutable(
      managedExecutable(scratch.host, layout.managed),
      `echo "codebase-memory-mcp ${layout.managed}"`,
    );
  }
  const pointer = layout.danglingPointer ?? layout.managed;
  await writeState(scratch.host, {
    ...(pointer === undefined ? {} : { managedVersion: pointer }),
    ...(layout.pin === undefined ? {} : { pin: layout.pin }),
  });
}

interface OrderCase {
  readonly scenario: string;
  readonly layout: Layout;
  readonly source: "pin" | "system" | "managed";
  readonly origin: string;
  /** The absolute path resolution must return for this layout. */
  readonly executable: (scratch: Scratch) => string;
}

const ordering: OrderCase[] = [
  {
    scenario: "a copy on PATH is adopted as a system installation",
    layout: { onPath: "0.10.8" },
    source: "system",
    origin: "PATH",
    executable: (scratch) => path.join(scratch.pathDir, EXECUTABLE_NAME),
  },
  {
    scenario: "a copy in ~/.local/bin is adopted when PATH has none",
    layout: { localBin: "0.10.8" },
    source: "system",
    origin: "~/.local/bin",
    executable: (scratch) => path.join(upstreamInstallDir(scratch.host), EXECUTABLE_NAME),
  },
  {
    scenario: "PATH wins over ~/.local/bin",
    layout: { onPath: "0.10.8", localBin: "0.9.0" },
    source: "system",
    origin: "PATH",
    executable: (scratch) => path.join(scratch.pathDir, EXECUTABLE_NAME),
  },
  {
    scenario: "a managed copy resolves when no system copy exists",
    layout: { managed: "0.10.8" },
    source: "managed",
    origin: "bin/0.10.8",
    executable: (scratch) => managedExecutable(scratch.host, "0.10.8"),
  },
  {
    // The whole point of the ordering: CBM owns one canonical cache root, so
    // adopting the operator's existing installation is the only safe default.
    scenario: "a system copy beats a managed copy that is also present",
    layout: { onPath: "0.9.0", managed: "0.10.8" },
    source: "system",
    origin: "PATH",
    executable: (scratch) => path.join(scratch.pathDir, EXECUTABLE_NAME),
  },
  {
    scenario: "a pin overrides both a system and a managed copy",
    layout: { onPath: "0.9.0", managed: "0.10.8", pin: "0.10.8" },
    source: "pin",
    origin: "0.10.8",
    executable: (scratch) => managedExecutable(scratch.host, "0.10.8"),
  },
  {
    scenario: "a pin with no managed copy behind it falls through to PATH",
    layout: { onPath: "0.9.0", pin: "0.10.8" },
    source: "system",
    origin: "PATH",
    executable: (scratch) => path.join(scratch.pathDir, EXECUTABLE_NAME),
  },
];

let scratch: Scratch;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await dropScratch(scratch);
});

test("every case names itself distinctly", () => {
  const scenarios = ordering.map((entry) => entry.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("resolution order", () => {
  test.each(ordering)("$scenario", async ({ layout, source, origin, executable }) => {
    await place(scratch, layout);

    const resolution = await resolveExecutable(scratch.host);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.resolved.source).toBe(source);
    expect(resolution.resolved.origin).toBe(origin);
    expect(resolution.resolved.executable).toBe(executable(scratch));
  });
});

describe("a managed copy is reported even when it is not resolved", () => {
  test("resolution prefers the system copy while the managed one stays on disk", async () => {
    await place(scratch, { onPath: "0.9.0", managed: "0.10.8" });

    const resolution = await resolveExecutable(scratch.host);
    const managed = await managedCopy(scratch.host);

    expect(resolution.ok && resolution.resolved.source).toBe("system");
    expect(managed?.version).toBe("0.10.8");
    expect(await Bun.file(managed?.executable ?? "").exists()).toBe(true);
  });

  test("a pointer with no file behind it reports no managed copy", async () => {
    await place(scratch, { onPath: "0.9.0", danglingPointer: "0.10.8" });
    expect(await managedCopy(scratch.host)).toBeNull();
  });
});

describe("nothing resolves", () => {
  test("the failure names both remedies", async () => {
    await place(scratch, {});

    const resolution = await resolveExecutable(scratch.host);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;

    expect(resolution.reason).toContain("/cbm install");
    expect(resolution.reason).toContain("install.sh");
  });
});

import { expect, test } from "bun:test";
import path from "node:path";

import ompCodebaseMemoryAugmentation from "../../src/augment-entry.ts";
import ompCodebaseMemory from "../../src/index.ts";
import { dropScratch, makeScratch } from "../support/scratch.ts";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

test("native skills and agents coexist; only a competing extension makes both entries stand down", async () => {
  const scratch = await makeScratch();
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const directory = path.join(scratch.home, ".omp", "agent");
  try {
    const nativeFiles = [
      path.join(directory, "skills", "codebase-memory", "SKILL.md"),
      path.join(directory, "agents", "codebase-memory.md"),
      path.join(directory, "agents", "codebase-memory-scout.md"),
      path.join(directory, "agents", "codebase-memory-auditor.md"),
    ];
    for (const file of nativeFiles) await Bun.write(file, "native CBM context\n");
    process.env["PI_CODING_AGENT_DIR"] = directory;

    const commands: string[] = [];
    const events: string[] = [];
    const api = {
      logger: { info: () => {} },
      setLabel: () => {},
      registerCommand: (name: string) => { commands.push(name); },
      on: (event: string) => { events.push(event); },
    } as unknown as ExtensionAPI;

    ompCodebaseMemory(api);
    ompCodebaseMemoryAugmentation(api);
    expect(commands).toEqual(["cbm"]);
    expect(events).toEqual(["session_start", "session_start", "tool_result", "session_shutdown"]);

    const competing = path.join(directory, "extensions", "codebase-memory.ts");
    await Bun.write(competing, "// operator-owned extension\n");
    commands.length = events.length = 0;
    ompCodebaseMemory(api);
    ompCodebaseMemoryAugmentation(api);
    expect(commands).toEqual([]);
    expect(events).toEqual([]);
    expect(await Bun.file(competing).text()).toBe("// operator-owned extension\n");
    for (const file of nativeFiles) expect(await Bun.file(file).text()).toBe("native CBM context\n");
  } finally {
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await dropScratch(scratch);
  }
});

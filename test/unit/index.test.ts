import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import ompCodebaseMemoryAugmentation from "../../src/augment-entry.ts";
import ompCodebaseMemory from "../../src/index.ts";
import { dropScratch, makeScratch, writeFakeExecutable } from "../support/scratch.ts";

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

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

test("headless install reports the confirmation refusal and leaves the existing executable untouched", async () => {
  const scratch = await makeScratch();
  const previous = { HOME: process.env["HOME"], PATH: process.env["PATH"], PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"] };
  const executable = path.join(scratch.pathDir, "codebase-memory-mcp");
  await writeFakeExecutable(executable, "printf 'codebase-memory-mcp 0.12.1\\n'");
  const original = await Bun.file(executable).text();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const notifications: Record<string, unknown>[] = [];
  try {
    process.env["HOME"] = scratch.home;
    process.env["PATH"] = scratch.pathDir;
    process.env["PI_CODING_AGENT_DIR"] = path.join(scratch.home, "agent");
    const api = {
      logger: {
        info: (_message: string, details: Record<string, unknown>) => { notifications.push(details); },
        error: () => { throw new Error("headless reporting failed"); },
      },
      setLabel: () => {},
      registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => { commands.set(name, options); },
      on: () => {},
    } as unknown as ExtensionAPI;
    ompCodebaseMemory(api);
    const command = commands.get("cbm");
    if (!command) throw new Error("missing lifecycle command");
    const ctx = {
      hasUI: false,
      ui: {
        confirm: () => { throw new Error("headless confirmation requested"); },
        notify: () => { throw new Error("headless notification is not visible"); },
      },
    } as unknown as ExtensionCommandContext;
    await command.handler("install 0.12.1", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.["type"]).toBe("error");
    expect(String(notifications[0]?.["message"])).toContain(executable);
    expect(String(notifications[0]?.["message"])).toContain("no interactive UI");
    expect(existsSync(path.join(scratch.home, ".omp", "codebase-memory"))).toBe(false);
    expect(await Bun.file(executable).text()).toBe(original);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await dropScratch(scratch);
  }
});

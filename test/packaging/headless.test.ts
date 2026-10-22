import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { SPAWN_BUDGET_MS } from "../support/fake-graph.ts";
import { dropScratch, makeScratch, writeFakeExecutable } from "../support/scratch.ts";

test("headless install preserves the executable and reports refusal with error-only logging", async () => {
  const scratch = await makeScratch();
  const executable = path.join(scratch.pathDir, "codebase-memory-mcp");
  const logDirectory = path.join(scratch.root, "logs");
  try {
    await writeFakeExecutable(executable, "printf 'codebase-memory-mcp 0.12.1\\n'");
    const original = await Bun.file(executable).text();
    // Bun caches homedir(); establish HOME before the child starts.
    const script = `
      import { homedir } from "node:os";
      import * as logger from ${JSON.stringify(Bun.resolveSync("@oh-my-pi/pi-utils/logger", import.meta.dir))};
      import extension from ${JSON.stringify(path.resolve(import.meta.dir, "../../dist/index.js"))};
      logger.setTransports({ file: ${JSON.stringify(logDirectory)}, console: false });
      const commands = new Map();
      extension({
        logger,
        setLabel() {},
        registerCommand(name, options) { commands.set(name, options); },
        on() {},
      });
      await commands.get("cbm").handler("install 0.12.1", {
        hasUI: false,
        ui: {
          confirm() { throw new Error("headless confirmation requested"); },
          notify() {},
        },
      });
      logger.flush();
      console.log(JSON.stringify({ home: homedir() }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: scratch.home,
      env: {
        HOME: scratch.home,
        PATH: scratch.pathDir,
        PI_CODING_AGENT_DIR: path.join(scratch.home, "agent"),
        OMP_LOG_LEVEL: "error",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ home: scratch.home });
    const files = (await readdir(logDirectory)).filter((name) => name.endsWith(".log"));
    const records = await Promise.all(files.map((name) => Bun.file(path.join(logDirectory, name)).text()));
    const notifications = records.join("\n").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe("error");
    expect(notifications[0].message).toContain(executable);
    expect(notifications[0].message).toContain("no interactive UI");
    expect(existsSync(path.join(scratch.home, ".omp", "codebase-memory"))).toBe(false);
    expect(await Bun.file(executable).text()).toBe(original);
  } finally {
    await dropScratch(scratch);
  }
}, SPAWN_BUDGET_MS);

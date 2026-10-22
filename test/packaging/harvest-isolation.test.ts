import { expect, test } from "bun:test";
import { chmod, readdir } from "node:fs/promises";
import path from "node:path";

import { collect } from "../../src/harvest/collect.ts";
import { clientVocabulary } from "../../src/harvest/vocabulary.ts";
import { SPAWN_BUDGET_MS } from "../support/fake-graph.ts";
import { dropScratch, makeScratch } from "../support/scratch.ts";

test("harvest collection and vocabulary probing preserve inherited Claude configuration", async () => {
  const scratch = await makeScratch();
  const previous = process.env["CLAUDE_CONFIG_DIR"];
  const external = path.join(scratch.root, "external-claude");
  const sentinel = path.join(external, "settings.json");
  const fixture = path.resolve(import.meta.dir, "../fixtures/harvest/cbm-0.12.1");
  try {
    await Bun.write(sentinel, "operator configuration\n");
    const skill = await Bun.file(path.join(fixture, "claude/skills/codebase-memory/SKILL.md")).text();
    const rule = await Bun.file(path.join(fixture, "augment/rules/codebase-memory.md")).text();
    const names = ["codebase-memory.md", "codebase-memory-scout.md", "codebase-memory-auditor.md"];
    const agents = await Promise.all(names.map((name) => Bun.file(path.join(fixture, "augment/agents", name)).text()));
    const executable = path.join(scratch.pathDir, "fixture-installer");
    // This installer honors the same config override, including before rejection.
    await Bun.write(executable, `#!${process.execPath}
import path from "node:path";
const home = process.env.HOME;
const claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
await Bun.write(path.join(claude, "settings.json"), "installer configuration\\n");
if (process.argv.includes("--dry-run")) {
  console.error("  claude  Claude Code\\n  augment  Augment");
  process.exit(1);
}
await Bun.write(path.join(claude, "skills/codebase-memory/SKILL.md"), ${JSON.stringify(skill)});
await Bun.write(path.join(home, ".augment/rules/codebase-memory.md"), ${JSON.stringify(rule)});
const names = ${JSON.stringify(names)};
const agents = ${JSON.stringify(agents)};
for (let i = 0; i < names.length; i++) {
  await Bun.write(path.join(home, ".augment/agents", names[i]), agents[i]);
}
`);
    await chmod(executable, 0o755);
    process.env["CLAUDE_CONFIG_DIR"] = external;

    expect(await collect(executable)).toEqual({ skill, rule, agents });
    expect(await Bun.file(sentinel).text()).toBe("operator configuration\n");
    expect(await readdir(external)).toEqual(["settings.json"]);

    expect([...await clientVocabulary(executable)]).toEqual(["claude", "augment"]);
    expect(await Bun.file(sentinel).text()).toBe("operator configuration\n");
    expect(await readdir(external)).toEqual(["settings.json"]);
  } finally {
    if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previous;
    await dropScratch(scratch);
  }
}, SPAWN_BUDGET_MS);

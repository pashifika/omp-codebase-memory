import { describe, expect, test } from "bun:test";
import path from "node:path";

import { checkToolSurface, driftedTools, referencedTools } from "../../src/tools.ts";

import type { GraphClient } from "../../src/graph.ts";

/**
 * The tool-surface drift check, against a recorded `tools/list` response.
 *
 * The primary drift detector runs on the operator's machine, so the thing worth
 * testing is the comparison: which names the shipped guidance references, and
 * what happens when the executable no longer has one of them.
 */

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "tools-list-v0.10.8.json");

interface RecordedList {
  readonly result: { readonly tools: readonly { readonly name: string }[] };
}

const recorded = (await Bun.file(FIXTURE).json()) as RecordedList;
const available = recorded.result.tools.map((tool) => tool.name);

/** A client whose `tools/list` answer is fixed. */
function listingClient(names: readonly string[] | null): GraphClient {
  return {
    call: async () => null,
    toolNames: async () => names,
    close: () => {},
  };
}

describe("the names the shipped artifacts reference", () => {
  test("are read from the committed skill, not from a second list in this repository", () => {
    const referenced = referencedTools();
    expect(referenced).not.toBeNull();
    expect(referenced ?? []).toContain("search_graph");
    expect(referenced ?? []).toContain("check_index_coverage");
  });

  /**
   * The precision that makes a notice worth reading.
   *
   * The skill backticks a response field (`has_more`) and another harness's own
   * tool (`delegate_task`) in the same style as a tool name. Extracting every
   * backtick would report both as missing on a perfectly current executable.
   */
  test("exclude backticked names that were never CBM tools", () => {
    const referenced = referencedTools() ?? [];
    expect(referenced).not.toContain("has_more");
    expect(referenced).not.toContain("delegate_task");
  });

  test("are exactly the tools the recorded executable reports", () => {
    expect([...(referencedTools() ?? [])].sort()).toEqual([...available].sort());
  });

  test("cannot be read from a skill with no tool enumeration", () => {
    expect(referencedTools("---\nname: x\ndescription: y\n---\n# No tools here\n")).toBeNull();
  });
});

interface DriftCase {
  readonly scenario: string;
  /** The names the executable reports. */
  readonly reports: readonly string[];
  readonly expected: readonly string[];
}

const driftCases: DriftCase[] = [
  { scenario: "an executable with every referenced tool has drifted from nothing", reports: available, expected: [] },
  {
    scenario: "a renamed tool is reported under the name the artifacts still use",
    reports: available.map((name) => (name === "search_graph" ? "graph_search" : name)),
    expected: ["search_graph"],
  },
  {
    scenario: "a removed tool is reported",
    reports: available.filter((name) => name !== "check_index_coverage"),
    expected: ["check_index_coverage"],
  },
  {
    scenario: "an executable reporting no tools at all names every referenced one",
    reports: [],
    expected: [...available],
  },
  {
    scenario: "a tool the executable added but the artifacts do not name is not drift",
    reports: [...available, "brand_new_tool"],
    expected: [],
  },
];

test.each(driftCases)("$scenario", ({ reports, expected }) => {
  expect([...(driftedTools(reports) ?? [])].sort()).toEqual([...expected].sort());
});

test("an unreadable shipped enumeration is not reported as upstream drift", () => {
  expect(driftedTools(available, "# nothing enumerated here\n")).toBeNull();
});

describe("the notice", () => {
  test("names the missing tool and the executable version", async () => {
    const notice = await checkToolSurface(
      listingClient(available.filter((name) => name !== "trace_path")),
      "codebase-memory-mcp 0.11.0",
    );
    expect(notice).toContain("trace_path");
    expect(notice).toContain("codebase-memory-mcp 0.11.0");
  });

  test("is not shown when every referenced name is present", async () => {
    expect(await checkToolSurface(listingClient(available), "codebase-memory-mcp 0.10.8")).toBeNull();
  });

  test("is not shown when the tool list could not be obtained, and the reason is recorded", async () => {
    const recordedDebug: string[] = [];
    const notice = await checkToolSurface(listingClient(null), "codebase-memory-mcp 0.10.8", {
      onDebug: (message) => recordedDebug.push(message),
    });

    expect(notice).toBeNull();
    expect(recordedDebug).toHaveLength(1);
    expect(recordedDebug[0]).toContain("could not be obtained");
  });
});

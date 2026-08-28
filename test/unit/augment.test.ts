import { describe, expect, test } from "bun:test";

import { createAugmenter } from "../../src/augment.ts";

import type { AugmentDeps } from "../../src/augment.ts";
import type { GraphClient } from "../../src/graph.ts";
import type { ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";

/**
 * The `tool_result` handler, whose only two obligations are additive.
 *
 * Every failure path must return `undefined`, because that is what leaves the
 * tool's own result reaching the model exactly as the tool produced it. And
 * every success must return the observed content plus new content, because
 * `tool_result` handlers are chained: replacing the array would discard what
 * another extension contributed.
 */

const PROJECT = { name: "app", root: "/work/app" };
const CWD = "/work/app/src";

/**
 * A text chunk, as a tool produces one.
 *
 * Declared here rather than imported: `TextContent` lives in the provider
 * package that OMP re-exports internally, and the only property these tests
 * assert on is the pair below.
 */
interface Chunk {
  readonly type: "text";
  readonly text: string;
}

const text = (value: string): Chunk => ({ type: "text", text: value });

/** The appended block's text, or `""` when the last chunk is not text. */
function appendedText(result: ToolResultEventResult | undefined): string {
  const last = result?.content?.at(-1);
  return last !== undefined && last.type === "text" ? last.text : "";
}

/** A `grep` result over `pattern`, with `content` as the tool's own output. */
function grepResult(pattern: string, content: readonly Chunk[] = [text("src/a.ts:1: hit")]): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "grep",
    input: { pattern },
    content: [...content],
    isError: false,
    details: undefined,
  };
}

function globResult(pattern: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-2",
    toolName: "glob",
    input: { path: pattern },
    content: [text("src/a.ts")],
    isError: false,
    details: undefined,
  };
}

function readResult(target: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-3",
    toolName: "read",
    input: { path: target },
    content: [text("1: const a = 1;")],
    isError: false,
    details: undefined,
  };
}

/** A `search_graph` JSON answer holding one group of `count` symbols. */
function symbols(count: number): unknown {
  return {
    cols: ["name", "label", "lines", "in", "out"],
    groups: [
      {
        qn_prefix: "app.src.a",
        file: "src/a.ts",
        rows: Array.from({ length: count }, (_, index) => [`symbol${index}`, "Function", "1-2", 0, 0]),
      },
    ],
  };
}

/** A `check_index_coverage` answer reporting one gap. */
const PARTIAL_COVERAGE = {
  paths: [
    {
      requested_path: "src/a.ts",
      status: "partial",
      recommended_action: "read_source_and_reindex",
      coverage: [{ path: "src/a.ts", kind: "parse_partial", detail: "lines 40-90", match: "exact" }],
    },
  ],
  caveat: "Best-effort signal only. No recorded issue does not prove completeness.",
};

const CLEAN_COVERAGE = {
  paths: [{ requested_path: "src/a.ts", status: "no_recorded_issue", coverage: [] }],
};

interface Recorder {
  readonly client: GraphClient;
  /** Every `tools/call` made, in order. */
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>> }[];
}

/** A client answering from `answers`, recording what it was asked. */
function recordingClient(answers: Readonly<Record<string, unknown>>): Recorder {
  const calls: { tool: string; args: Readonly<Record<string, unknown>> }[] = [];
  return {
    calls,
    client: {
      call: async (tool, args) => {
        calls.push({ tool, args });
        const answer = answers[tool];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      },
      toolNames: async () => null,
      close: () => {},
    },
  };
}

interface Harness {
  handle: (event: ToolResultEvent) => Promise<ToolResultEventResult | undefined>;
  readonly notices: string[];
  readonly debugLines: string[];
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>> }[];
  close: () => void;
}


/** An augmenter over a recording client, with the notice and debug sinks captured. */
function harness(answers: Readonly<Record<string, unknown>>, client?: GraphClient | null): Harness {
  const recorder = recordingClient(answers);
  const notices: string[] = [];
  const debugLines: string[] = [];
  const deps: AugmentDeps = {
    openClient: async () => (client === null ? null : (client ?? recorder.client)),
    cwd: CWD,
    notify: (message) => notices.push(message),
    debug: (message) => debugLines.push(message),
  };
  const augmenter = createAugmenter(deps);
  return {
    handle: async (event) => await augmenter.handle(event),
    notices,
    debugLines,
    calls: recorder.calls,
    close: () => augmenter.close(),
  };
}

/** The `list_projects` answer that resolves `CWD` to {@link PROJECT}. */
const LISTED = { projects: [{ name: PROJECT.name, root_path: PROJECT.root }] };

describe("what the augmentation adds", () => {
  test("appends matching graph symbols to a grep, leaving its output untouched", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(2) });
    const original = [text("src/a.ts:1: hit"), text("src/b.ts:9: hit")];

    const result = await under.handle(grepResult("resolveExecutable", original));

    expect(result?.content?.slice(0, 2)).toEqual(original);
    expect(result?.content).toHaveLength(3);
    expect(appendedText(result)).toContain("app.src.a.symbol0");
    expect(appendedText(result)).toContain("src/a.ts");
    under.close();
  });

  test("searches the graph by identifier, so a regex pattern is usable as a query", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    await under.handle(grepResult("^\\s*(resolveExecutable|readState)\\b"));

    const search = under.calls.find((call) => call.tool === "search_graph");
    expect(search?.args["query"]).toBe("resolveExecutable readState");
    expect(search?.args["project"]).toBe(PROJECT.name);
    under.close();
  });

  test("searches a glob by file path, because a glob names files rather than symbols", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    await under.handle(globResult("src/**/*.ts"));

    const search = under.calls.find((call) => call.tool === "search_graph");
    expect(search?.args["file_pattern"]).toBe("src/(?:.*/)?[^/]*\\.ts");
    under.close();
  });

  test("appends coverage findings and the completeness caveat to a partially covered read", async () => {
    const under = harness({ list_projects: LISTED, check_index_coverage: PARTIAL_COVERAGE });
    const result = await under.handle(readResult("/work/app/src/a.ts"));

    expect(appendedText(result)).toContain("partial");
    expect(appendedText(result)).toContain("lines 40-90");
    expect(appendedText(result)).toContain("does not prove completeness");
    under.close();
  });

  test("asks about the read path relative to the project root, which is how the index records it", async () => {
    const under = harness({ list_projects: LISTED, check_index_coverage: PARTIAL_COVERAGE });
    await under.handle(readResult("/work/app/src/a.ts"));

    const probe = under.calls.find((call) => call.tool === "check_index_coverage");
    expect(probe?.args["paths"]).toEqual(["src/a.ts"]);
    under.close();
  });

  test("bounds the appended entries however many the graph returns", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(200) });
    const result = await under.handle(grepResult("symbol"));

    const lines = appendedText(result).split("\n");
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(12);
    under.close();
  });

  test("preserves content a prior handler in the chain already added", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    const withPrior = [text("src/a.ts:1: hit"), text("added by another extension")];

    const result = await under.handle(grepResult("resolveExecutable", withPrior));

    expect(result?.content?.slice(0, 2)).toEqual(withPrior);
    expect(result?.content).toHaveLength(3);
    under.close();
  });

  test("resolves the project once and reuses it across calls", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    await under.handle(grepResult("alpha"));
    await under.handle(grepResult("beta"));

    expect(under.calls.filter((call) => call.tool === "list_projects")).toHaveLength(1);
    expect(under.calls.filter((call) => call.tool === "search_graph")).toHaveLength(2);
    under.close();
  });
});

interface FailOpenCase {
  readonly scenario: string;
  /** Graph answers by tool name. An `Error` value makes the call throw. */
  readonly answers: Readonly<Record<string, unknown>>;
  readonly event: ToolResultEvent;
  /** `null` opens no client at all, standing in for an unresolved executable. */
  readonly client?: null;
  /** Tools that must not have been asked, because the handler stopped earlier. */
  readonly unasked?: readonly string[];
  readonly notices?: number;
}

/**
 * Every path that must leave the tool's result exactly as the tool produced it.
 *
 * `undefined` is the assertion in all of them: OMP keeps the observed content
 * when a handler returns nothing, so nothing this package does can subtract
 * from a result.
 */
const failOpenCases: FailOpenCase[] = [
  {
    scenario: "an errored tool result is left alone and the graph is never asked",
    answers: { list_projects: LISTED, search_graph: symbols(1) },
    event: { ...grepResult("resolveExecutable"), isError: true },
    unasked: ["list_projects", "search_graph"],
  },
  {
    scenario: "a tool this handler does not cover is left alone",
    answers: { list_projects: LISTED },
    event: {
      type: "tool_result",
      toolCallId: "call-9",
      toolName: "bash",
      input: { command: "ls" },
      content: [text("a.ts")],
      isError: false,
      details: undefined,
    },
    unasked: ["list_projects"],
  },
  {
    scenario: "no executable resolving adds nothing and shows no notice",
    answers: {},
    event: grepResult("resolveExecutable"),
    client: null,
    notices: 0,
  },
  {
    scenario: "a graph that will not answer list_projects adds nothing and shows no notice",
    answers: { search_graph: symbols(1) },
    event: grepResult("resolveExecutable"),
    unasked: ["search_graph"],
    notices: 0,
  },
  {
    scenario: "an unreadable list_projects answer adds nothing",
    answers: { list_projects: { total: 0 }, search_graph: symbols(1) },
    event: grepResult("resolveExecutable"),
    unasked: ["search_graph"],
    notices: 0,
  },
  {
    scenario: "a search the graph could not answer adds nothing",
    answers: { list_projects: LISTED },
    event: grepResult("resolveExecutable"),
  },
  {
    scenario: "a search with no graph match adds nothing",
    answers: { list_projects: LISTED, search_graph: symbols(0) },
    event: grepResult("resolveExecutable"),
  },
  {
    scenario: "a grep pattern holding no identifier is not searched for",
    answers: { list_projects: LISTED, search_graph: symbols(1) },
    event: grepResult("^\\s+$"),
    unasked: ["search_graph"],
  },
  {
    scenario: "a fully covered read adds nothing",
    answers: { list_projects: LISTED, check_index_coverage: CLEAN_COVERAGE },
    event: readResult("/work/app/src/a.ts"),
  },
  {
    scenario: "a read outside the project root is not asked about",
    answers: { list_projects: LISTED, check_index_coverage: PARTIAL_COVERAGE },
    event: readResult("/etc/hosts"),
    unasked: ["check_index_coverage"],
  },
  {
    scenario: "a read of an internal URL is not asked about",
    answers: { list_projects: LISTED, check_index_coverage: PARTIAL_COVERAGE },
    event: readResult("memory://abc"),
    unasked: ["check_index_coverage"],
  },
  {
    scenario: "a graph call that throws adds nothing",
    answers: { list_projects: LISTED, search_graph: new Error("the session died") },
    event: grepResult("resolveExecutable"),
  },
];

test.each(failOpenCases)("$scenario", async ({ answers, event, client, unasked, notices }) => {
  const under = harness(answers, client);
  const original = [...event.content];

  expect(await under.handle(event)).toBeUndefined();

  // The event's own content is never mutated: the handler returns a new array
  // or nothing at all.
  expect(event.content).toEqual(original);
  for (const tool of unasked ?? []) {
    expect(under.calls.map((call) => call.tool)).not.toContain(tool);
  }
  if (notices !== undefined) expect(under.notices).toHaveLength(notices);
  under.close();
});

test("an unindexed directory is reported once, not once per search", async () => {
  const under = harness({ list_projects: { projects: [{ name: "other", root_path: "/elsewhere" }] } });

  expect(await under.handle(grepResult("alpha"))).toBeUndefined();
  expect(await under.handle(grepResult("beta"))).toBeUndefined();
  expect(await under.handle(readResult("/work/app/src/a.ts"))).toBeUndefined();

  expect(under.notices).toHaveLength(1);
  expect(under.notices[0]).toContain("no indexed project");
  under.close();
});

test("a graph failure is recorded in the debug log rather than shown", async () => {
  const under = harness({ list_projects: LISTED, search_graph: new Error("the session died") });

  await under.handle(grepResult("resolveExecutable"));

  expect(under.notices).toEqual([]);
  expect(under.debugLines.join("\n")).toContain("the session died");
  under.close();
});

test("every fail-open case names a distinct scenario", () => {
  const scenarios = failOpenCases.map((kase) => kase.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

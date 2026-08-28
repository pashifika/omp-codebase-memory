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

/**
 * A grouped `search_graph` answer holding one group of `count` symbols.
 *
 * The shape both selectors return: the qualified-name prefix and the file live
 * on the group, each row carries the bare name, and `in`/`out` carry the graph's
 * selected degree. Degree descends with the index so the ranking is observable.
 */
function symbols(count: number): unknown {
  return {
    cols: ["name", "label", "lines", "in", "out"],
    groups: [
      {
        qn_prefix: "app.src.a",
        file: "src/a.ts",
        rows: Array.from({ length: count }, (_, index) => [
          `symbol${index}`,
          "Function",
          "1-2",
          count - index,
          index,
        ]),
      },
    ],
  };
}

/**
 * A grouped answer whose in-degrees RISE with the index.
 *
 * The direction is the point. The graph does not rank a name-pattern answer, so
 * these arrive in its own `qn_prefix` order with the most depended-on symbol
 * last -- which is where a bound that took the response's first rows would drop
 * it. A fixture ordered the other way, or shorter than the bound, passes
 * whether the code ranks or not.
 */
function risingSymbols(count: number): unknown {
  return {
    cols: ["name", "label", "lines", "in", "out"],
    groups: [
      {
        qn_prefix: "app.src.a",
        file: "src/a.ts",
        rows: Array.from({ length: count }, (_, index) => [`symbol${index}`, "Function", "1-2", index + 1, 0]),
      },
    ],
  };
}

/**
 * A grouped answer whose names are long and not Latin.
 *
 * 200 CJK characters per name is 200 UTF-16 code units and 600 bytes, so twelve
 * of these rows sit under a 4,096-*character* bound and far over a 4,096-*byte*
 * one. That gap is the whole subject of the block bound.
 */
function wideSymbols(count: number): unknown {
  return {
    cols: ["name", "label", "lines", "in", "out"],
    groups: [
      {
        qn_prefix: "app.src.a",
        file: "src/a.ts",
        rows: Array.from({ length: count }, (_, index) => [
          `${"名".repeat(200)}${index}`,
          "Function",
          "1-2",
          count - index,
          0,
        ]),
      },
    ],
  };
}

/**
 * A grouped answer holding one row of every label that is not a definition.
 *
 * A name pattern matches all of these like any other node, and the keyword mode
 * that filtered them upstream is no longer used. Measured on this repository's
 * own index: `name_pattern: "(graph)"` answers 19 rows of which 7 are `Section`
 * -- markdown headings -- and one is a `Branch` whose group carries no file, so
 * its row would print an empty path. Every `Route` in the same index is a
 * synthesised path string with no file and no line range.
 */
const CONTAINERS = {
  cols: ["name", "label", "lines", "in", "out"],
  groups: [
    {
      qn_prefix: "app.src",
      file: "src/a.ts",
      rows: [
        ["a", "Module", "1-40", 0, 6],
        ["src", "Folder", "", 0, 0],
        ["__file__", "File", "", 0, 0],
        ["Gotchas", "Section", "71-76", 0, 0],
        ["feat-graph-context-and-agents", "Branch", "", 0, 0],
        ["app", "Project", "", 0, 0],
        ["__route__ANY__/work/app/src", "Route", "", 0, 0],
      ],
    },
  ],
};

/**
 * A flat `search_graph` answer holding `count` symbols.
 *
 * The shape the keyword mode returns, carrying a `rank` column where the
 * name-pattern mode carries `in` and `out`. Neither selector this package sends
 * produces it any more, and it stays fixtured because a release that changes
 * which mode answers which shape must degrade to a row without degree rather
 * than to silence.
 */
function flatSymbols(count: number): unknown {
  return {
    total: count,
    search_mode: "bm25",
    cols: ["qn", "label", "file", "lines", "rank"],
    rows: Array.from({ length: count }, (_, index) => [
      `app.src.a.symbol${index}`,
      "Function",
      "src/a.ts",
      "1-2",
      -19.04,
    ]),
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
  /** How many times the augmenter released the client. */
  closes(): number;
}

/** A client answering from `answers`, recording what it was asked. */
function recordingClient(answers: Readonly<Record<string, unknown>>): Recorder {
  const calls: { tool: string; args: Readonly<Record<string, unknown>> }[] = [];
  let closes = 0;
  return {
    calls,
    closes: () => closes,
    client: {
      call: async (tool, args) => {
        calls.push({ tool, args });
        const answer = answers[tool];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      },
      toolNames: async () => null,
      close: () => {
        closes += 1;
      },
    },
  };
}

interface Harness {
  handle: (event: ToolResultEvent) => Promise<ToolResultEventResult | undefined>;
  warm: () => Promise<void>;
  readonly notices: string[];
  readonly debugLines: string[];
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>> }[];
  closes(): number;
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
    closes: recorder.closes,
    warm: async () => await augmenter.warm(),
    close: () => augmenter.close(),
  };
}

/** The `list_projects` answer that resolves `CWD` to {@link PROJECT}. */
const LISTED = { projects: [{ name: PROJECT.name, root_path: PROJECT.root }] };

interface GlobCase {
  readonly scenario: string;
  readonly glob: string;
  /** The `file_pattern` sent, or `null` when the glob is not worth a query. */
  readonly expected: string | null;
}

const globCases: GlobCase[] = [
  { scenario: "a globstar collapses to one wildcard, so the top level still matches", glob: "src/**/*.ts", expected: "src/%.ts" },
  { scenario: "a single star becomes a wildcard", glob: "src/*.ts", expected: "src/%.ts" },
  { scenario: "a leading globstar collapses too", glob: "**/*.test.ts", expected: "%.test.ts" },
  { scenario: "a question mark becomes a single-character wildcard", glob: "src/a?.ts", expected: "src/a_.ts" },
  { scenario: "a plain directory is left as the substring it is", glob: "src", expected: "src" },
  { scenario: "only the first of a semicolon-delimited list is queried", glob: "src/*.ts; test/*.ts", expected: "src/%.ts" },
  { scenario: "the working root is not a search", glob: ".", expected: null },
  { scenario: "a pattern that selects everything is not a search", glob: "**", expected: null },
  { scenario: "an empty path is not a search", glob: "", expected: null },
];

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

  test("carries the graph's degree, labelled as degree rather than as callers", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(2) });

    const result = await under.handle(grepResult("resolveExecutable"));

    expect(appendedText(result)).toContain("2 in / 0 out");
    expect(appendedText(result)).toContain("not a caller count");
    under.close();
  });

  /**
   * The pool is what the ranking chooses from, so the fixture has to be bigger
   * than the bound and ordered against it.
   *
   * A three-row fixture against a bound of twelve truncates nothing, and would
   * pass over a `slice` taken from either end. Twenty rows whose in-degree rises
   * with the index fails unless the rows kept are the best twelve *and* they are
   * ordered by degree.
   */
  test("ranks by in-degree, so a truncating bound keeps the symbols most depended on", async () => {
    const under = harness({ list_projects: LISTED, search_graph: risingSymbols(20) });

    const result = await under.handle(grepResult("symbol"));
    const rows = appendedText(result)
      .split("\n")
      .filter((line) => line.startsWith("- "));

    expect(rows).toHaveLength(12);
    expect(rows.map((line) => /(\d+) in/u.exec(line)?.[1])).toEqual(
      ["20", "19", "18", "17", "16", "15", "14", "13", "12", "11", "10", "9"],
    );
    // The eight the bound drops are the eight the response listed first.
    expect(appendedText(result)).not.toContain("app.src.a.symbol0 ");
    under.close();
  });

  /**
   * The label filter is an allow-list, so a label nobody has seen is dropped.
   *
   * Every row here matched the pattern and none is a definition: three
   * containers, a markdown `Section`, the repository's `Branch`, the `Project`
   * itself, and a `Route` that is a synthesised path string. A deny-list of
   * `File`/`Folder`/`Module` appends the last four under a heading claiming the
   * operator's search found them.
   */
  test("appends nothing when every row is a non-definition, whatever the label", async () => {
    const under = harness({ list_projects: LISTED, search_graph: CONTAINERS });

    expect(await under.handle(grepResult("resolveExecutable"))).toBeUndefined();
    under.close();
  });

  /**
   * The allow-list is CBM's own symbol set, not this repository's.
   *
   * v0.10.8 repeats one list verbatim in four SQL statements --
   * `label IN ('Function','Method','Class','Struct','Interface','Enum','Type','Trait')`
   * -- and none of `Struct`, `Enum` or `Trait` occurs in this TypeScript
   * project's index, so an allow-list written from what is on hand here would
   * append nothing at all for a `grep` in a Go or a Rust repository.
   */
  test("appends the labels CBM itself treats as symbols, including ones this repository has none of", async () => {
    const under = harness({
      list_projects: LISTED,
      search_graph: {
        cols: ["name", "label", "lines", "in", "out"],
        groups: [
          {
            qn_prefix: "app.store",
            file: "src/store.go",
            rows: [
              ["Store", "Struct", "10-40", 7, 1],
              ["Kind", "Enum", "42-48", 3, 0],
              ["Readable", "Trait", "50-58", 2, 0],
            ],
          },
        ],
      },
    });

    const appended = appendedText(await under.handle(grepResult("Store")));

    expect(appended).toContain("app.store.Store (Struct) src/store.go:10-40");
    expect(appended).toContain("app.store.Kind (Enum)");
    expect(appended).toContain("app.store.Readable (Trait)");
    under.close();
  });

  test("appends a flat answer without a degree claim, because it carries no degree columns", async () => {
    const under = harness({ list_projects: LISTED, search_graph: flatSymbols(2) });

    const result = await under.handle(globResult("src/*.ts"));

    expect(appendedText(result)).toContain("app.src.a.symbol0");
    expect(appendedText(result)).not.toContain(" in / ");
    expect(appendedText(result)).not.toContain("not a caller count");
    under.close();
  });

  test("searches by name pattern rather than by keyword, so an appended row is one the grep matched", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    await under.handle(grepResult("^\\s*(resolveExecutable|readState)\\b"));

    const search = under.calls.find((call) => call.tool === "search_graph");
    expect(search?.args["name_pattern"]).toBe("(resolveExecutable|readState)");
    expect(search?.args["query"]).toBeUndefined();
    expect(search?.args["project"]).toBe(PROJECT.name);
    under.close();
  });

  test("deduplicates repeated identifiers, so a bounded pattern is not spent on one name twice", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    await under.handle(grepResult("readState.*readState"));

    const search = under.calls.find((call) => call.tool === "search_graph");
    expect(search?.args["name_pattern"]).toBe("(readState)");
    under.close();
  });

  /**
   * `file_pattern` is a LIKE match, not a regex.
   *
   * Measured against v0.10.8: `src` matches 276 nodes, `src/.*` matches none,
   * and `src/*` matches 275. A regex translation therefore selected nothing for
   * every `glob`, which is why the expected values below are LIKE wildcards.
   */
  test.each(globCases)("$scenario", async ({ glob, expected }) => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    await under.handle(globResult(glob));

    const search = under.calls.find((call) => call.tool === "search_graph");
    if (expected === null) {
      // The fact that distinguishes the two outcomes: a glob selecting the whole
      // project is not a question, so the graph is not asked at all. Asserting
      // an absent `file_pattern` instead would pass for a whole-project query
      // too, because a missing argument reads the same as no query.
      expect(search).toBeUndefined();
    } else {
      expect(search?.args["file_pattern"]).toBe(expected);
    }
    under.close();
  });

  /**
   * A grep's own `path` scope is part of the question it asked.
   *
   * Without it the appended rows can come from files the grep never searched,
   * under a heading saying they match "this grep".
   */
  test("narrows a grep by the path it was scoped to, so an appended row is in scope", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });
    await under.handle({ ...grepResult("readState"), input: { pattern: "readState", path: "src/**/*.ts" } });

    const search = under.calls.find((call) => call.tool === "search_graph");
    expect(search?.args["name_pattern"]).toBe("(readState)");
    expect(search?.args["file_pattern"]).toBe("src/%.ts");
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

  /**
   * The pool asked for, and the bound applied to it.
   *
   * The two are different numbers on purpose, and a fixture of 200 rows tests
   * neither: the server never returns more than `limit`, so the only honest
   * fixture is one the size of the pool. What has to hold is that the request
   * asks for the pool, the append carries the bound, and the heading says the
   * list is partial rather than presenting twelve as the whole answer.
   */
  test("asks for a pool larger than the append bound, and says so when it truncates", async () => {
    const under = harness({ list_projects: LISTED, search_graph: flatSymbols(50) });
    const result = await under.handle(grepResult("symbol"));

    const search = under.calls.find((call) => call.tool === "search_graph");
    expect(search?.args["limit"]).toBe(50);

    const lines = appendedText(result).split("\n");
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(12);
    expect(lines[0]).toContain("12 of 50 symbol(s)");
    under.close();
  });

  /**
   * A page the graph says it truncated is described as a page.
   *
   * `has_more` means the ranking ran over the 50 rows that came back rather than
   * over the 285 that matched, so a heading claiming the highest in-degree of
   * all of them would claim a ranking nothing performed.
   */
  test("says the ranking was over the page when the graph truncated it", async () => {
    const page = {
      total: 285,
      has_more: true,
      cols: ["name", "label", "lines", "in", "out"],
      groups: [
        {
          qn_prefix: "app.src.a",
          file: "src/a.ts",
          rows: Array.from({ length: 50 }, (_, index) => [`symbol${index}`, "Function", "1-2", 50 - index, 0]),
        },
      ],
    };
    const under = harness({ list_projects: LISTED, search_graph: page });

    const heading = appendedText(await under.handle(grepResult("symbol"))).split("\n")[0];

    expect(heading).toContain("12 of 285 symbol(s)");
    expect(heading).toContain("highest in-degree of the first 50");
    under.close();
  });

  test("says nothing about truncation when the whole answer fits", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(2) });
    const result = await under.handle(grepResult("symbol"));

    expect(appendedText(result).split("\n")[0]).toBe(
      `Codebase graph — 2 symbol(s) matching this grep in project ${PROJECT.name}:`,
    );
    under.close();
  });

  /**
   * The block bound is in bytes, cuts between rows, and re-heads what is left.
   *
   * A character count under-measures every non-Latin identifier -- the fixture's
   * rows are 200 characters and 600 bytes each -- and a cut inside a row leaves
   * half a qualified name and half a line range, which reads as a symbol that
   * does not exist. The closing note has to survive too: on a coverage block it
   * is the caveat `graph-augmentation "Scenario: Read of a partially covered
   * file"` requires.
   *
   * The heading is asserted against the rows because this exact fixture is what
   * caught its absence. A row count alone passed while the append read
   * `12 symbol(s) matching this grep` above FIVE rows -- a false statement about
   * what the block carries rather than a truncation of it, and reachable on any
   * answer whose qualified names average ~280 bytes. So the count is asserted as
   * a relation to the rows listed rather than as a number: whatever the bound
   * keeps, the heading has to say that, and in the `N of M` form that tells the
   * reader these are not all of them.
   */
  test("bounds the appended block in bytes, dropping whole rows from the end", async () => {
    const under = harness({ list_projects: LISTED, search_graph: wideSymbols(12) });
    const result = await under.handle(grepResult("symbol"));
    const appended = appendedText(result);
    const lines = appended.split("\n");
    const rows = lines.filter((line) => line.startsWith("- "));

    expect(new TextEncoder().encode(appended).length).toBeLessThanOrEqual(4_096);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(12);
    expect(/^Codebase graph — (\d+) of 12 symbol\(s\) matching this grep/u.exec(lines[0] ?? "")?.[1]).toBe(
      String(rows.length),
    );
    // Whole rows: every one still ends in the degree suffix it was built with.
    expect(rows.every((line) => line.endsWith(" in / 0 out"))).toBe(true);
    expect(lines.at(-1)).toContain("not a caller count");
    under.close();
  });

  /**
   * The bound covers the frame, and a server-supplied caveat is where that failed.
   *
   * `check_index_coverage` supplies its own `caveat` and this package prefers it
   * over the shipped fallback, so an upstream release deciding to send a
   * paragraph puts a server-chosen string into the closing note. Seeding the
   * budget with an unweighed note meant the constant bounded only the rows:
   * measured against the real `createAugmenter`, a 9,000-byte `caveat` produced
   * a 9,053-byte append carrying the heading, the caveat, and NO finding rows at
   * all -- every row hit the bound because the note had already spent it, which
   * also drops the reported reason `graph-augmentation "Scenario: Read of a
   * partially covered file"` requires. The same input now produces 655 bytes
   * with the reason and its gap present.
   *
   * The caveat is CJK on purpose. It is three bytes a character, so a cut taken
   * at a byte offset lands inside a character and the block comes back holding a
   * sequence that is not text; the decode below is `fatal` so that failure is
   * this test failing rather than mojibake nobody asserted on.
   */
  test("bounds a coverage block whose server-supplied caveat is enormous, keeping the finding", async () => {
    const under = harness({
      list_projects: LISTED,
      check_index_coverage: {
        paths: [
          {
            requested_path: "src/a.ts",
            status: "partial",
            coverage: [{ path: "src/a.ts", kind: "parse_partial", detail: "lines 40-90", match: "exact" }],
          },
        ],
        caveat: "名".repeat(3_000),
      },
    });

    const appended = appendedText(await under.handle(readResult("/work/app/src/a.ts")));
    const lines = appended.split("\n");
    const encoded = new TextEncoder().encode(appended);

    expect(encoded.length).toBeLessThanOrEqual(4_096);
    // The reason row and its gap, which the unbounded note used to displace.
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(appended).toContain("src/a.ts: partial");
    expect(appended).toContain("parse_partial — lines 40-90");
    // Cut, marked as cut, and still a well-formed string.
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(encoded)).toBe(appended);
    under.close();
  });

  /**
   * The third server-supplied string: the one the required row itself carries.
   *
   * A bounded frame moved the defect rather than closing it. The first coverage
   * finding interpolates `status` and `recommended_action`, both chosen by the
   * server, so either one large enough makes that row cost more than the whole
   * budget; the row is then dropped -- rows are dropped whole, and from the end,
   * which for the first row means all of them -- and the append comes back
   * carrying a heading and a caveat and no reason at all. Measured against the
   * real `createAugmenter`: a 20,000-character `status` produced 126 bytes and
   * ZERO rows, dropping the reported reason `graph-augmentation "Scenario: Read
   * of a partially covered file"` requires, which is the same obligation the
   * block cites when it chooses to cut the frame rather than the rows. The same
   * input now produces 683 bytes with the reason present.
   *
   * `status` rather than `recommended_action` is the sharper of the two, because
   * it is the reason itself: what survives the cut has to be the row's own
   * beginning, so the path and the status the reader needs come first and the
   * advice is what the bound takes. A large `detail` on a later gap is left to
   * the drop rule on purpose -- the reason row precedes it and survives its
   * loss, so no obligation rides on it.
   */
  test("bounds a coverage finding whose server-supplied status is enormous, keeping the reason", async () => {
    const under = harness({
      list_projects: LISTED,
      check_index_coverage: {
        paths: [
          {
            requested_path: "src/a.ts",
            status: `partial ${"s".repeat(20_000)}`,
            recommended_action: "read_source_and_reindex",
            coverage: [{ path: "src/a.ts", kind: "parse_partial", detail: "lines 40-90", match: "exact" }],
          },
        ],
      },
    });

    const appended = appendedText(await under.handle(readResult("/work/app/src/a.ts")));
    const lines = appended.split("\n");

    expect(new TextEncoder().encode(appended).length).toBeLessThanOrEqual(4_096);
    const reason = lines.filter((line) => line.startsWith("- "));
    expect(reason).toHaveLength(1);
    expect(reason[0]?.startsWith("- src/a.ts: partial ")).toBe(true);
    expect(reason[0]?.endsWith("…")).toBe(true);
    // The caveat the scenario requires alongside the reason, still last.
    expect(lines.at(-1)).toContain("not proof of completeness");
    under.close();
  });

  /**
   * The other server-supplied frame: the project name, which the heading carries.
   *
   * `list_projects` chooses the name and every heading interpolates it, so the
   * same unweighed-frame bug reached the symbol path too -- measured, a
   * 9,000-byte project name produced a 9,174-byte append whose heading claimed
   * `1 symbol(s)` and listed none, which is a false statement rather than a
   * truncation. The row is the assertion that matters: the heading may be cut,
   * but it may not be left describing rows the block does not carry.
   */
  test("bounds a symbol block whose server-supplied project name is enormous, keeping the row", async () => {
    const under = harness({
      list_projects: { projects: [{ name: "p".repeat(9_000), root_path: PROJECT.root }] },
      search_graph: symbols(1),
    });

    const appended = appendedText(await under.handle(grepResult("symbol")));
    const lines = appended.split("\n");

    expect(new TextEncoder().encode(appended).length).toBeLessThanOrEqual(4_096);
    expect(lines[0]).toContain("1 symbol(s) matching this grep");
    expect(lines[0]?.endsWith("…")).toBe(true);
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(appended).toContain("app.src.a.symbol0");
    expect(lines.at(-1)).toContain("not a caller count");
    under.close();
  });

  test("preserves content a prior handler in the chain already added", async () => {
    const under = harness({ list_projects: LISTED, search_graph: flatSymbols(1) });
    const withPrior = [text("src/a.ts:1: hit"), text("added by another extension")];

    const result = await under.handle(grepResult("resolveExecutable", withPrior));

    expect(result?.content?.slice(0, 2)).toEqual(withPrior);
    expect(result?.content).toHaveLength(3);
    under.close();
  });

  test("resolves the project once and reuses it across calls", async () => {
    const under = harness({ list_projects: LISTED, search_graph: flatSymbols(1) });
    await under.handle(grepResult("alpha"));
    await under.handle(grepResult("beta"));

    expect(under.calls.filter((call) => call.tool === "list_projects")).toHaveLength(1);
    expect(under.calls.filter((call) => call.tool === "search_graph")).toHaveLength(2);
    under.close();
  });

  /**
   * The warm-up exists so the *first* search is useful.
   *
   * A query refuses to wait for the handshake -- ~2.9 s against a warm CBM
   * daemon, ~9 s when the daemon has to start -- so without a background open
   * the first `grep` in every session would append nothing. Warming resolves the
   * project too, which is why no search afterwards asks for it again.
   */
  test("warming opens the session and resolves the project before any search", async () => {
    const under = harness({ list_projects: LISTED, search_graph: flatSymbols(1) });

    await under.warm();
    expect(under.calls.map((call) => call.tool)).toEqual(["list_projects"]);

    const result = await under.handle(grepResult("resolveExecutable"));
    expect(appendedText(result)).toContain("app.src.a.symbol0");
    expect(under.calls.filter((call) => call.tool === "list_projects")).toHaveLength(1);
    under.close();
  });

  test("warming with no executable is silent and leaves later searches untouched", async () => {
    const under = harness({}, null);

    await under.warm();
    expect(await under.handle(grepResult("resolveExecutable"))).toBeUndefined();
    expect(under.notices).toEqual([]);
    under.close();
  });

  /**
   * An action nobody can carry out is dropped, and only the action.
   *
   * CBM recommends `read_source_and_reindex` for every uncovered path, including
   * one under `node_modules` that is excluded by configuration and matched an
   * ancestor rather than the file. Attaching that instruction to every read of a
   * dependency is how the caveat becomes background noise. The reason and the
   * completeness caveat stay: `graph-augmentation "Scenario: Read of a partially
   * covered file"` requires both.
   */
  test("drops a recommended action nothing could act on, keeping the reason and the caveat", async () => {
    const under = harness({
      list_projects: LISTED,
      check_index_coverage: {
        paths: [
          {
            requested_path: "node_modules/pkg/index.js",
            status: "excluded",
            recommended_action: "read_source_and_reindex",
            coverage: [{ path: "node_modules", kind: "not_indexed_dir", detail: "excluded subtree", match: "ancestor" }],
          },
        ],
      },
    });

    const appended = appendedText(await under.handle(readResult("/work/app/node_modules/pkg/index.js")));

    expect(appended).not.toContain("read_source_and_reindex");
    expect(appended).toContain("excluded");
    expect(appended).toContain("not_indexed_dir");
    expect(appended).toContain("not proof of completeness");
    under.close();
  });

  test("keeps the recommended action when the gap is one a reindex would close", async () => {
    const under = harness({ list_projects: LISTED, check_index_coverage: PARTIAL_COVERAGE });

    expect(appendedText(await under.handle(readResult("/work/app/src/a.ts")))).toContain("read_source_and_reindex");
    under.close();
  });

  /**
   * `session_shutdown` has to actually release the CBM process.
   *
   * A long-lived OMP process opens one session after another, and the client is
   * held for the life of each. Nothing else in the suite observed the release,
   * so an augmenter that dropped its reference without closing would have looked
   * identical.
   */
  test("closing releases the graph client the session opened", async () => {
    const under = harness({ list_projects: LISTED, search_graph: symbols(1) });

    await under.handle(grepResult("resolveExecutable"));
    expect(under.closes()).toBe(0);

    under.close();
    expect(under.closes()).toBe(1);
  });

  /**
   * The same, when the shutdown lands while the open is still in flight.
   *
   * `close()` used to read a field the open assigns only after it resolves, so a
   * shutdown during the warm-up released nothing, the open then stored a client
   * nobody held, and `warm()` carried on into the handshake -- leaving a CBM
   * process alive after the session that started it was gone.
   */
  test("closing during an in-flight open releases the client that open produced", async () => {
    const opening = Promise.withResolvers<GraphClient | null>();
    let closes = 0;
    let handshakes = 0;
    const client: GraphClient = {
      call: async () => null,
      toolNames: async () => {
        handshakes += 1;
        return null;
      },
      close: () => {
        closes += 1;
      },
    };
    const augmenter = createAugmenter({
      openClient: async () => await opening.promise,
      cwd: CWD,
      notify: () => {},
      debug: () => {},
    });

    const warming = augmenter.warm();
    augmenter.close();
    opening.resolve(client);
    await warming;

    expect(closes).toBe(1);
    expect(handshakes).toBe(0);
  });

  /**
   * An `openClient` that rejects is not memoised as a rejection.
   *
   * The inverse of the pitfall `src/project.ts:90-98` documents: a memoised
   * rejected promise re-throws into every later tool result, so the handler's
   * own catch reports the same failure once per `grep` for the whole session.
   *
   * The debug stream is the only place that difference is observable, which is
   * why it is asserted rather than discarded. `opened ??=` memoises the promise
   * whether the open resolves to `null` or rejects, so `opens` is 1 and both
   * results are `undefined` in both worlds -- proven by replacing the `catch`
   * inside the memoised IIFE with a `finally`, which left this file green until
   * these three assertions were added. What the rejection actually costs is a
   * throw per tool result: one line naming the *open* becomes one line per
   * `grep` naming the *augmentation*, which is the same cause reported forever
   * under a heading that misattributes it.
   */
  test("an open that throws is recorded once, as an open, and adds nothing afterwards", async () => {
    let opens = 0;
    const debugLines: string[] = [];
    const augmenter = createAugmenter({
      openClient: async () => {
        opens += 1;
        throw new Error("the executable vanished");
      },
      cwd: CWD,
      notify: () => {},
      debug: (message) => debugLines.push(message),
    });

    expect(await augmenter.handle(grepResult("alpha"))).toBeUndefined();
    expect(await augmenter.handle(grepResult("beta"))).toBeUndefined();

    expect(opens).toBe(1);
    expect(debugLines).toEqual(["opening the graph session failed: the executable vanished"]);
    expect(debugLines.some((line) => line.startsWith("augmentation failed:"))).toBe(false);
    augmenter.close();
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
    answers: { list_projects: LISTED, search_graph: flatSymbols(1) },
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
    answers: { search_graph: flatSymbols(1) },
    event: grepResult("resolveExecutable"),
    unasked: ["search_graph"],
    notices: 0,
  },
  {
    scenario: "an unreadable list_projects answer adds nothing",
    answers: { list_projects: { total: 0 }, search_graph: flatSymbols(1) },
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
    answers: { list_projects: LISTED, search_graph: flatSymbols(0) },
    event: grepResult("resolveExecutable"),
  },
  {
    scenario: "a grep pattern holding no identifier is not searched for",
    answers: { list_projects: LISTED, search_graph: flatSymbols(1) },
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

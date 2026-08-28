import { describe, expect, test } from "bun:test";

import { CHECKSUMS_LIMIT_BYTES, parseChecksums } from "../../src/release.ts";

/** The `checksums.txt` v0.10.8 actually published, byte for byte. */
const PUBLISHED = await Bun.file("test/fixtures/checksums-v0.10.8.txt").text();

const encoder = new TextEncoder();

const DARWIN_ARM64 = "codebase-memory-mcp-darwin-arm64.tar.gz";
const DARWIN_ARM64_DIGEST = "9bd840dfb3ec7eaef4f310382057adaa5b0e904df883104d03ffcf39836afd07";

/** Matches the digest column of the darwin/arm64 line, for mutating it. */
const DARWIN_ARM64_LINE = /^[0-9a-f]{64}(\s+codebase-memory-mcp-darwin-arm64\.tar\.gz)$/mu;

interface PublishedDigestCase {
  readonly scenario: string;
  readonly archive: string;
  readonly digest: string;
}

const publishedDigests: PublishedDigestCase[] = [
  {
    scenario: "the darwin/arm64 archive resolves to its published digest",
    archive: DARWIN_ARM64,
    digest: DARWIN_ARM64_DIGEST,
  },
  {
    scenario: "the darwin/amd64 archive resolves to its published digest",
    archive: "codebase-memory-mcp-darwin-amd64.tar.gz",
    digest: "2b193085410af3801634a522f4b17dcd6699695e015a068393c87817c1d260d4",
  },
  {
    scenario: "the linux/arm64 portable archive resolves to its published digest",
    archive: "codebase-memory-mcp-linux-arm64-portable.tar.gz",
    digest: "5697d986d9716c913163b4bff7b3a294287f3b843e993bc1ff71e78dcdc21781",
  },
  {
    scenario: "the linux/amd64 portable archive resolves to its published digest",
    archive: "codebase-memory-mcp-linux-amd64-portable.tar.gz",
    digest: "6eef49652bc0c7820f43114125044d40bf7f4d97c11b2592f6b0f6a307702325",
  },
  {
    // The published file lists the non-portable Linux names beside the portable
    // ones. A prefix match would verify one asset's bytes against the other's
    // line, so the distinct digest is the assertion that selection is exact.
    scenario: "the non-portable linux/arm64 archive resolves to a different digest",
    archive: "codebase-memory-mcp-linux-arm64.tar.gz",
    digest: "e2804a20f5a6fc392af361525a232703e351b7d1aacb81b88eef806eec5959fa",
  },
  {
    // Upstream publishes a `-ui-` alias for every asset, carrying the same
    // bytes and therefore the same digest as the archive it aliases (fixture
    // lines 5 and 22 are identical but for the name). So this case can only
    // show the alias entry is there and gets selected -- a parser that resolved
    // it through its neighbour's line would return the same digest and pass.
    // Exactness is proven by the case above, whose digest genuinely differs
    // from the name it sits beside.
    scenario: "the -ui- alias for linux/arm64 portable is present and selectable",
    archive: "codebase-memory-mcp-ui-linux-arm64-portable.tar.gz",
    digest: "5697d986d9716c913163b4bff7b3a294287f3b843e993bc1ff71e78dcdc21781",
  },
];

interface RefusalCase {
  readonly scenario: string;
  /** The body handed to the parser, built from the published file where relevant. */
  readonly body: Uint8Array;
  readonly archive: string;
  /** The text the refusal must name. */
  readonly reported: RegExp;
}

const refusals: RefusalCase[] = [
  {
    scenario: "an archive absent from the file is refused rather than defaulted",
    body: encoder.encode(PUBLISHED),
    archive: "codebase-memory-mcp-plan9-arm64.tar.gz",
    reported: /no SHA-256 digest for codebase-memory-mcp-plan9-arm64\.tar\.gz/u,
  },
  {
    scenario: "an archive whose line was removed is refused",
    body: encoder.encode(
      PUBLISHED.split("\n")
        .filter((line) => !line.includes(DARWIN_ARM64))
        .join("\n"),
    ),
    archive: DARWIN_ARM64,
    reported: /no SHA-256 digest/u,
  },
  {
    scenario: "a digest holding a non-hex character is refused rather than truncated",
    body: encoder.encode(
      PUBLISHED.replace(
        DARWIN_ARM64_LINE,
        `${DARWIN_ARM64_DIGEST.slice(0, 62)}ZZ$1`,
      ),
    ),
    archive: DARWIN_ARM64,
    reported: /invalid SHA-256 digest/u,
  },
  {
    scenario: "a digest of the wrong length is refused",
    body: encoder.encode(
      PUBLISHED.replace(DARWIN_ARM64_LINE, `${DARWIN_ARM64_DIGEST.slice(0, 62)}$1`),
    ),
    archive: DARWIN_ARM64,
    reported: /invalid SHA-256 digest/u,
  },
  {
    scenario: "two different digests for one archive are refused rather than last-wins",
    body: encoder.encode(
      `${PUBLISHED}${"0".repeat(64)}  ${DARWIN_ARM64}\n`,
    ),
    archive: DARWIN_ARM64,
    reported: /conflicting SHA-256 digests/u,
  },
  {
    scenario: "a body over the 1 MiB limit is refused unread",
    body: new Uint8Array(CHECKSUMS_LIMIT_BYTES + 1),
    archive: DARWIN_ARM64,
    reported: /over the 1048576 byte safety limit/u,
  },
];

interface AcceptedSpellingCase {
  readonly scenario: string;
  /** One `checksums.txt` line, spelled the way the case is about. */
  readonly line: string;
  readonly digest: string;
}

const acceptedSpellings: AcceptedSpellingCase[] = [
  {
    scenario: "an uppercase digest is normalized rather than rejected",
    line: `${DARWIN_ARM64_DIGEST.toUpperCase()}  ${DARWIN_ARM64}`,
    digest: DARWIN_ARM64_DIGEST,
  },
  {
    // Upstream's installer accepts `$2 == "*" archive`, which is how sha256sum
    // spells a binary-mode line.
    scenario: "the BSD binary-mode marker before the name is accepted",
    line: `${DARWIN_ARM64_DIGEST} *${DARWIN_ARM64}`,
    digest: DARWIN_ARM64_DIGEST,
  },
  {
    scenario: "the same digest repeated for one archive is accepted",
    line: `${DARWIN_ARM64_DIGEST}  ${DARWIN_ARM64}\n${DARWIN_ARM64_DIGEST}  ${DARWIN_ARM64}`,
    digest: DARWIN_ARM64_DIGEST,
  },
  {
    scenario: "a trailing field after the name does not prevent selection",
    line: `${DARWIN_ARM64_DIGEST}  ${DARWIN_ARM64}  ignored`,
    digest: DARWIN_ARM64_DIGEST,
  },
];

test("every case names itself distinctly", () => {
  const scenarios = [...publishedDigests, ...refusals, ...acceptedSpellings].map(
    (entry) => entry.scenario,
  );
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("the real published checksums.txt", () => {
  test.each(publishedDigests)("$scenario", ({ archive, digest }) => {
    expect(parseChecksums(encoder.encode(PUBLISHED), archive)).toBe(digest);
  });
});

describe("refusals", () => {
  test.each(refusals)("$scenario", ({ body, archive, reported }) => {
    expect(() => parseChecksums(body, archive)).toThrow(reported);
  });
});

describe("accepted digest spellings", () => {
  test.each(acceptedSpellings)("$scenario", ({ line, digest }) => {
    expect(parseChecksums(encoder.encode(`${line}\n`), DARWIN_ARM64)).toBe(digest);
  });
});

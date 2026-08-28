import { describe, expect, test } from "bun:test";

import { fetchHttps, nextHop, tagFromLocation } from "../../src/release.ts";

/**
 * The transport-downgrade defence and the release-tag parser.
 *
 * Both validate input this package does not control -- a redirect's `location`
 * header -- and the tag one of them yields is interpolated into a download URL
 * and used as an on-disk directory name. Neither is reachable through a real
 * request without a TLS origin that redirects to plain HTTP, which is why the
 * validation is a function.
 */

const HTTPS_ORIGIN = "https://github.com/DeusData/codebase-memory-mcp/releases/latest";

interface HopCase {
  readonly scenario: string;
  /** The `location` header the hop carries. */
  readonly location: string | null;
  /** The URL the hop must lead to. */
  readonly expected: string;
}

const acceptedHops: HopCase[] = [
  {
    scenario: "an absolute HTTPS location is followed as given",
    location: "https://objects.githubusercontent.com/asset",
    expected: "https://objects.githubusercontent.com/asset",
  },
  {
    scenario: "a path-relative location is resolved against the URL it came from",
    location: "/DeusData/codebase-memory-mcp/releases/tag/v0.10.8",
    expected: "https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.10.8",
  },
  {
    // A scheme-relative location inherits the current scheme, which is HTTPS --
    // resolving against the current URL is what makes that true rather than
    // leaving the hop protocol-less.
    scenario: "a scheme-relative location inherits HTTPS",
    location: "//objects.githubusercontent.com/asset",
    expected: "https://objects.githubusercontent.com/asset",
  },
];

interface HopRefusalCase {
  readonly scenario: string;
  readonly location: string | null;
  readonly reported: RegExp;
}

const refusedHops: HopRefusalCase[] = [
  {
    scenario: "a plain HTTP location is refused without being followed",
    location: "http://objects.githubusercontent.com/asset",
    reported: /refusing non-HTTPS redirect: http:\/\/objects\.githubusercontent\.com\/asset/u,
  },
  {
    scenario: "a loopback HTTP location is refused like any other downgrade",
    location: "http://127.0.0.1:8080/asset",
    reported: /refusing non-HTTPS redirect/u,
  },
  {
    scenario: "a non-HTTP scheme is refused",
    location: "file:///etc/passwd",
    reported: /refusing non-HTTPS redirect: file:\/\/\/etc\/passwd/u,
  },
  {
    scenario: "a missing location header is refused rather than retried",
    location: null,
    reported: /answered 302 with no location header/u,
  },
  {
    scenario: "an empty location header is refused",
    location: "",
    reported: /answered 302 with no location header/u,
  },
];

interface TagCase {
  readonly scenario: string;
  readonly status: number;
  readonly location: string;
  readonly tag: string;
}

const acceptedTags: TagCase[] = [
  {
    // The value GitHub actually answered when this was measured.
    scenario: "the measured 302 to a tag yields that tag",
    status: 302,
    location: "https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.10.8",
    tag: "v0.10.8",
  },
  {
    scenario: "a relative location to a tag yields that tag",
    status: 302,
    location: "/DeusData/codebase-memory-mcp/releases/tag/v1.0.0",
    tag: "v1.0.0",
  },
  {
    scenario: "a 301 is accepted as a redirect",
    status: 301,
    location: "https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.9.0",
    tag: "v0.9.0",
  },
  {
    scenario: "a percent-encoded tag is decoded",
    status: 302,
    location: "https://github.com/DeusData/codebase-memory-mcp/releases/tag/v1.0.0%2Bbuild",
    tag: "v1.0.0+build",
  },
];

interface TagRefusalCase {
  readonly scenario: string;
  readonly status: number;
  readonly location: string | null;
  readonly reported: RegExp;
}

const refusedTags: TagRefusalCase[] = [
  {
    scenario: "a 200 is refused, because a tag can only come from a redirect",
    status: 200,
    location: "https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.10.8",
    reported: /to redirect to a tag, got HTTP 200/u,
  },
  {
    scenario: "a 404 is refused",
    status: 404,
    location: null,
    reported: /got HTTP 404/u,
  },
  {
    scenario: "a redirect with no location is refused",
    status: 302,
    location: null,
    reported: /no location header/u,
  },
  {
    scenario: "a non-HTTPS release location is refused",
    status: 302,
    location: "http://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.10.8",
    reported: /refusing non-HTTPS release location/u,
  },
  {
    // A redirect that leads somewhere else entirely must not be mined for a
    // path segment that happens to look like a version.
    scenario: "a location outside the repository's tag path is refused",
    status: 302,
    location: "https://evil.example/DeusData/codebase-memory-mcp/releases/tag/v0.10.8",
    reported: /unexpected release location/u,
  },
  {
    scenario: "a location naming another repository is refused",
    status: 302,
    location: "https://github.com/attacker/repo/releases/tag/v0.10.8",
    reported: /unexpected release location/u,
  },
  {
    scenario: "a location with no tag after the prefix is refused",
    status: 302,
    location: "https://github.com/DeusData/codebase-memory-mcp/releases/tag/",
    reported: /unexpected release tag in location/u,
  },
  {
    // The tag becomes a directory name under `bin/`, so a separator in it is a
    // traversal attempt whatever it decodes from.
    scenario: "a tag holding a path separator is refused",
    status: 302,
    location: "https://github.com/DeusData/codebase-memory-mcp/releases/tag/v1%2F..%2F..%2Fetc",
    reported: /unexpected release tag in location/u,
  },
];

test("every case names itself distinctly", () => {
  const scenarios = [...acceptedHops, ...refusedHops, ...acceptedTags, ...refusedTags].map(
    (entry) => entry.scenario,
  );
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("redirect hops", () => {
  test.each(acceptedHops)("$scenario", ({ location, expected }) => {
    expect(nextHop(HTTPS_ORIGIN, 302, location)).toBe(expected);
  });

  test.each(refusedHops)("$scenario", ({ location, reported }) => {
    expect(() => nextHop(HTTPS_ORIGIN, 302, location)).toThrow(reported);
  });
});

describe("the initial request", () => {
  test("a non-HTTPS URL is refused before any connection is opened", async () => {
    await expect(fetchHttps("http://127.0.0.1:1/never")).rejects.toThrow(
      /refusing non-HTTPS request: http:\/\/127\.0\.0\.1:1\/never/u,
    );
  });
});

describe("release tag resolution", () => {
  test.each(acceptedTags)("$scenario", ({ status, location, tag }) => {
    expect(tagFromLocation(status, location)).toBe(tag);
  });

  test.each(refusedTags)("$scenario", ({ status, location, reported }) => {
    expect(() => tagFromLocation(status, location)).toThrow(reported);
  });
});

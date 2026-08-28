/**
 * Upstream's release surface: the only network entry point in this package,
 * plus the two pieces of published metadata acquisition depends on.
 *
 * Every verification property here exists because upstream's `install.sh` has
 * it. A step dropped is a security property silently removed, so each one
 * names the upstream behaviour it reproduces.
 */

/** The repository this package acquires from. */
export const UPSTREAM_REPO = "DeusData/codebase-memory-mcp";

const RELEASES = `https://github.com/${UPSTREAM_REPO}/releases`;

/** Where `releases/latest` redirects a tag out of. */
const LATEST = `${RELEASES}/latest`;

/**
 * Redirect hops `fetchHttps` will follow.
 *
 * Matches the `--max-redirs 5` upstream's installer passes to curl. The bound
 * exists so a redirect loop fails as a bounded error rather than hanging.
 */
const MAX_REDIRECTS = 5;

/** Default per-request deadline. A version check must not hang a session. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * `checksums.txt` above this size is refused unread.
 *
 * Upstream's installer refuses the same 1 MiB, for the same reason: the digest
 * file is a few kilobytes of text, so anything larger is not the file this
 * package believes it is parsing.
 */
export const CHECKSUMS_LIMIT_BYTES = 1_048_576;

export interface FetchOptions {
  /**
   * Redirect hops to follow, capped at {@link MAX_REDIRECTS}.
   *
   * `0` returns the first response as received, redirect status and `location`
   * header included -- which is how the release tag is read.
   */
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}

/**
 * The only place this package opens a network connection.
 *
 * HTTPS is required for the initial request and re-checked on every redirect
 * hop, because a redirect is the one place a transport downgrade can arrive
 * from outside the URL this code chose. `redirect: "manual"` is what makes
 * that possible: the platform's own redirect following would take the hop
 * before this code could look at it.
 */
export async function fetchHttps(url: string, options: FetchOptions = {}): Promise<Response> {
  const budget = Math.min(options.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
  let current = requireHttps(url, "request");

  for (let hop = 0; ; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "*/*" },
    });

    const redirected = response.status >= 300 && response.status < 400;
    if (!redirected || hop >= budget) return response;

    current = nextHop(current, response.status, response.headers.get("location"));
  }
}

/**
 * The URL one redirect hop leads to, or a refusal.
 *
 * Separated from {@link fetchHttps} because it is the whole transport-downgrade
 * defence and the only part of it a test can reach without a TLS origin that
 * redirects to plain HTTP. A relative `location` is resolved against the URL it
 * came from, which is also what makes a scheme-relative `//host/path` inherit
 * HTTPS rather than slip through as protocol-less.
 */
export function nextHop(current: string, status: number, location: string | null): string {
  if (location === null || location === "") {
    throw new Error(`${current} answered ${status} with no location header`);
  }
  return requireHttps(new URL(location, current).href, "redirect");
}

/** `url` when it is HTTPS; otherwise a refusal naming which hop downgraded. */
function requireHttps(url: string, kind: "request" | "redirect"): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing non-HTTPS ${kind}: ${url}`);
  }
  return parsed.href;
}

/**
 * The release tag a `releases/latest` response names.
 *
 * Separated from {@link resolveLatestTag} for the same reason as
 * {@link nextHop}: this is validation of attacker-adjacent input -- the tag it
 * yields is interpolated into a download URL and used as an on-disk directory
 * name -- and a function is the only way to test the refusals without standing
 * up a server that impersonates GitHub.
 */
export function tagFromLocation(status: number, location: string | null): string {
  if (status < 300 || status >= 400) {
    throw new Error(`expected ${LATEST} to redirect to a tag, got HTTP ${status}`);
  }
  if (location === null || location === "") {
    throw new Error(`${LATEST} answered ${status} with no location header`);
  }

  const resolved = new URL(location, LATEST);
  if (resolved.protocol !== "https:") {
    throw new Error(`refusing non-HTTPS release location: ${resolved.href}`);
  }

  // The origin is checked as well as the path. Without it a redirect to
  // `https://elsewhere/DeusData/codebase-memory-mcp/releases/tag/v9.9.9` would
  // be mined for a version string this package then treats as the newest
  // release -- the path prefix alone says nothing about who answered.
  const prefix = `/${UPSTREAM_REPO}/releases/tag/`;
  if (resolved.origin !== new URL(LATEST).origin || !resolved.pathname.startsWith(prefix)) {
    throw new Error(`unexpected release location: ${resolved.href}`);
  }

  const tag = decodeURIComponent(resolved.pathname.slice(prefix.length));
  if (tag === "" || tag.includes("/")) {
    throw new Error(`unexpected release tag in location: ${resolved.href}`);
  }
  return tag;
}

/**
 * The newest release tag, read from the `releases/latest` redirect.
 *
 * Not the GitHub API: that answer is rate-limited per IP, which turns a
 * background version check into an intermittent failure on a shared network
 * and would need a token for something requiring no authentication at all.
 * The redirect needs neither, and asset downloads already use the same
 * `releases/` mechanism.
 */
export async function resolveLatestTag(): Promise<string> {
  const response = await fetchHttps(LATEST, { maxRedirects: 0 });
  return tagFromLocation(response.status, response.headers.get("location"));
}

/**
 * The published SHA-256 digest for exactly `archive`.
 *
 * Reproduces upstream's `awk '$2 == archive || $2 == "*" archive'` selection,
 * and its three refusals. Exactness is load-bearing rather than pedantic:
 * a real `checksums.txt` lists `codebase-memory-mcp-ui-darwin-arm64.tar.gz`
 * beside `codebase-memory-mcp-darwin-arm64.tar.gz`, so a substring or prefix
 * match would silently verify one asset's bytes against another's line.
 */
export function parseChecksums(body: Uint8Array, archive: string): string {
  if (body.byteLength > CHECKSUMS_LIMIT_BYTES) {
    throw new Error(
      `checksums.txt is ${body.byteLength} bytes, over the ${CHECKSUMS_LIMIT_BYTES} byte safety limit`,
    );
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  let digest: string | undefined;

  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 2) continue;

    const name = fields[1] ?? "";
    if (name !== archive && name !== `*${archive}`) continue;

    const candidate = (fields[0] ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(candidate)) {
      throw new Error(`invalid SHA-256 digest for ${archive}: ${fields[0] ?? ""}`);
    }
    if (digest !== undefined && digest !== candidate) {
      throw new Error(`conflicting SHA-256 digests for ${archive} in checksums.txt`);
    }
    digest = candidate;
  }

  if (digest === undefined) {
    throw new Error(`no SHA-256 digest for ${archive} in checksums.txt`);
  }
  return digest;
}

/**
 * The published artifacts acquisition reads.
 *
 * An interface rather than three free functions so the failure paths -- digest
 * mismatch, an unexpected archive member, a candidate that will not run -- are
 * reachable from a test without a network or a mutated release.
 */
export interface ReleaseSource {
  /** The newest release tag. */
  latestTag(): Promise<string>;
  /** `checksums.txt` for `tag`, as bytes so its size can be refused unread. */
  checksums(tag: string): Promise<Uint8Array>;
  /** Release asset `name` published under `tag`. */
  asset(tag: string, name: string): Promise<Uint8Array>;
}

/** The real release source, over {@link fetchHttps}. */
export function githubReleaseSource(): ReleaseSource {
  return {
    latestTag: resolveLatestTag,
    checksums: (tag) => download(`${RELEASES}/download/${encodeURIComponent(tag)}/checksums.txt`),
    asset: (tag, name) =>
      download(`${RELEASES}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`),
  };
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetchHttps(url);
  if (!response.ok) {
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

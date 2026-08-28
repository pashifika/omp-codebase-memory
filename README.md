# omp-codebase-memory

An [OMP](https://github.com/can1357/oh-my-pi) extension that owns the
[`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) (CBM)
executable's lifecycle and wires exactly one MCP server entry into OMP's native
user configuration.

CBM indexes a repository into a persistent code knowledge graph and exposes it
over MCP. Its own installer configures 44 client surfaces, and OMP is not one of
them: OMP only sees CBM indirectly, by discovering a Claude, Codex, or Gemini
config that some *other* client's installation happened to leave behind. An
OMP-only machine gets nothing.

This package is the missing path. `omp plugin install` is the whole setup step.

It also does the part that being reachable does not cover: a fresh session is
told the graph exists, delegated work gets CBM's three read-only agent tiers,
and a `grep` that missed a structural answer gets it appended anyway.

## What it does

- **Resolves the executable, system installation first.** An existing
  `codebase-memory-mcp` is adopted as-is and never replaced. A managed copy is
  downloaded only when none is found.
- **Verifies a download the way upstream's installer does.** Release tag from
  the `releases/latest` redirect, `checksums.txt` digest match for the exact
  archive name, HTTPS on every redirect hop, a closed four-member archive
  namespace, regular-file-not-symlink extraction, the Linux `-portable` build,
  macOS quarantine removal and ad-hoc signing, and a `--version` smoke run
  before anything is adopted.
- **Owns one key in `~/.omp/agent/mcp.json`.** `codebase-memory-mcp`, written
  with the resolved absolute path, corrected when that path changes, removed on
  uninstall. No other user file is touched.
- **Tracks versions without fighting CBM's own updater.** A managed copy is
  updated by this package. An adopted system copy is only reported on.
- **Ships a skill, a rulebook rule, and three agents.** All four are derived
  from the CBM executable rather than written by hand, so the guidance a session
  gets is the guidance that release actually documents.
- **Appends graph context to searches and reads.** Matching symbols on a `grep`
  or `glob`, index-coverage gaps on a `read`. Optional, bounded, and it can only
  ever add.

## Install

### Git spec (primary)

```sh
omp plugin install github:pashifika/omp-codebase-memory
```

CI runs this command, through OMP's own installer, on pushes to `main`, on
release tag pushes, and on manual dispatch — as
`github:pashifika/omp-codebase-memory#<ref>`, into a home directory with no
prior plugin state. `omp plugin install` validates what it installed by loading
the declared extension entry, so a ref that installs green also registers green.

### Marketplace

```sh
omp plugin marketplace add github:pashifika/omp-codebase-memory
omp plugin install omp-codebase-memory@omp-codebase-memory
```

The catalog lives at `.omp-plugin/marketplace.json`. Marketplace installs are
discovered through a different provider than git installs, so this is an
additional entry point rather than a replacement.

That provider contributes skills and agents, and it is not a rules provider, so
a marketplace install does not receive the rule. Since the rule is a rulebook
entry rather than an always-apply injection, what it costs a session either way
is one listed name and description, and the skill carries the same guidance in
full. The skill, the three agents, the MCP entry, and the augmentation all work
on both routes.

### Development

```sh
git clone https://github.com/pashifika/omp-codebase-memory
cd omp-codebase-memory
bun install
omp plugin link .
```

`omp.extensions` names `./dist/index.js` and the augmentation feature names
`./dist/augment.js`. Both are committed, so a fresh clone loads without a build
step. Run `bun run build` after changing anything under `src/`; CI fails if
either committed bundle is not byte-identical to one built from the current
source.

CI links its own checkout with this command, so the development install is
verified to be discovered. That the committed bundle then *loads* through OMP's
loader is `test/packaging/bundle.test.ts` — `omp plugin link` registers a
checkout without loading it.

## Commands

| Command | What it does |
|---|---|
| `/cbm status` | Resolved source, absolute path, local version, last known upstream version, pin state, resolved agent directory, whether the MCP entry is present and current, and which indexed project covers this directory |
| `/cbm install [version]` | Downloads, verifies, and adopts a managed copy. Asks for confirmation first when a system executable already resolves |
| `/cbm update` | Updates a managed copy. For an adopted system copy, reports the newer version and points at CBM's own `update` |
| `/cbm pin <version>` | Holds a version: update checks report but never adopt |
| `/cbm unpin` | Releases the pin |
| `/cbm uninstall` | Removes the managed copy, this package's state, and the owned MCP entry. Leaves an adopted system executable alone |

No command needs an interactive terminal. In a session with no UI, `/cbm
install` fails with the reason rather than waiting for a confirmation that
cannot arrive.

There is no index command. CBM's own guidance, which this package ships, tells
the model to confirm the project with `list_projects` or `index_status` at
session start, and `index_repository` is already in the model's tool surface. Ask
the agent to index a repository; a second path through `/cbm` would duplicate
one that already works.

## Graph context

Four surfaces, all derived from the CBM executable by `bun run harvest` and
committed:

| Surface | Path | What it gives a session |
|---|---|---|
| Skill | `skills/codebase-memory/SKILL.md` | The tool matrix, the exploration and tracing workflows, the Cypher examples, and the gotchas. Read on demand as `skill://codebase-memory` |
| Rule | `rules/codebase-memory.md` | The priority order and the evidence tiers, injected into every turn, so a fresh session and a post-compaction turn both carry it |
| Agents | `agents/codebase-memory{,-scout,-auditor}.md` | CBM's Scout, Verify, and Auditor tiers, as read-only subagents that verify supplied evidence against exact source |

The agents declare `tools: read, grep, glob` and name no MCP tool. Their prompt
bodies tell the child that the parent must supply the graph evidence and that
the child must not claim MCP access, which is the situation an OMP subagent is
in. Every name carries the `codebase-memory-` prefix, so none of them can
shadow one of OMP's own bundled agents.

### The augmentation feature

`graph-augmentation` is a manifest feature, enabled by default. When it is
active, a `grep` or `glob` result gains the graph symbols whose names hold one of
the identifiers the search used, and a `read` gains the index's coverage findings
for that file — but only when coverage reports a gap, so a fully indexed file
reads exactly as it did before.

Each appended symbol carries its qualified name, label, file, line range, and the
graph's degree, written `11 in / 14 out`. The degree is the part worth the
tokens: a file and line range for a symbol your search already matched is mostly
a restatement, and `lsp` gives it more precisely where a language server exists,
but how many edges reach a symbol is not something `grep`, `glob`, or
`lsp references` can tell you. It is CBM's selected degree over CALLS, USAGE,
CALL_REFERENCE, INHERITS, and IMPLEMENTS — not a caller count. Use `trace_path`
for callers; it is also the only tool here that answers transitively.

Install without it, or turn it off later:

```sh
omp plugin install 'github:pashifika/omp-codebase-memory[]'
omp plugin features omp-codebase-memory --disable graph-augmentation
omp plugin features omp-codebase-memory --enable graph-augmentation
```

The feature owns one extension entry and nothing else. Turning it off leaves the
skill, the rule, the agents, and the MCP entry exactly as they were.

Four properties hold whether or not it is on:

1. It only ever appends. Every chunk the tool produced reaches the model
   unchanged, including content another extension added first.
2. It never runs on `tool_call`. OMP treats a throwing or blocking handler there
   as a refusal of the tool call, so a slow graph query could deny your `grep`.
   The handler is on `tool_result`, where a failure is caught and the run
   continues.
3. Every query has a deadline in the low hundreds of milliseconds and a bound on
   how much it may append. A query that misses the deadline appends nothing.
4. An errored tool result is left alone.

It holds one CBM process for the session, opened in the background at session
start and closed at shutdown, at about 2.6 MB resident.

That opening is not instant, and it is why the first seconds of a session are
different. A CBM process needs roughly 2.9 s to answer its first request when a
CBM daemon is already warm, and about 8.5 s when it has to start the daemon
itself. A search will not wait for that — the deadline above is the whole point —
so a search issued before the session is ready appends nothing and is otherwise
untouched. In practice you type a prompt first and the session is long ready; in
a scripted `omp -p` run the first one or two searches often are not. Nothing is
lost either way, and `~/.omp/logs` records one line per session saying when the
session became ready and which project it resolved.

## The system-first policy, and why it is not negotiable

Resolution order is **pin, `PATH`, `~/.local/bin`, managed copy** — system
before managed.

CBM resolves one canonical per-account cache root, and refuses to run when a
process is configured with a different root while any CBM session or command is
active. Two executables of *different versions* sharing that root produce
mismatched index generations. Giving a managed copy its own private cache root
would avoid the conflict by re-indexing every repository a second time, which
for a large tree is hours of work and gigabytes to hold the same answers twice.

So the operator's existing installation wins. The cost is that this package
cannot guarantee a version, and that cost is made visible rather than hidden:
`/cbm status` names the source, and an out-of-date system copy produces a
pointer to CBM's own `update` rather than an attempt to perform it.

`/cbm install` while a system copy resolves is still possible — it is your
machine — but it explains the shared-cache-root consequence and requires
explicit confirmation first.

## Where things live

| Path | Owner | Notes |
|---|---|---|
| `~/.omp/codebase-memory/bin/<version>/` | this package | Managed executables, one directory per version |
| `~/.omp/codebase-memory/state.json` | this package | Version pointer, digest, pin, last check time |
| `<agent-dir>/mcp.json` | the operator | This package owns the single `codebase-memory-mcp` key and nothing else |
| `~/.local/bin/codebase-memory-mcp` | CBM's installer | Read during resolution, **never** written |
| `<plugin root>/skills`, `rules`, `agents` | this package | The harvested context surfaces, discovered by OMP's own plugin scan. Removed with the plugin |
| CBM's cache root and its graph | CBM | Shared with every other client on the account. Nothing here indexes, deletes, or overrides it |

`<agent-dir>` is resolved the way OMP resolves it: `PI_CODING_AGENT_DIR` when
set, otherwise `~/.omp/profiles/<name>/agent` under `OMP_PROFILE`/`PI_PROFILE`,
otherwise `~/.omp/agent`. A profile-scoped operator therefore gets the entry
only in the active profile — writing every profile would configure profiles you
never asked about — and `/cbm status` names the directory it resolved so the
scope is visible.

The managed copy lives outside the plugin tree on purpose. OMP caches plugins in
version-qualified directories and replaces them on reinstall, so an executable
stored inside would be discarded by a routine plugin upgrade and re-downloaded
every time.

## Rollback

Two steps, in either order:

```sh
/cbm uninstall          # managed copy, state, and the owned MCP entry
omp plugin uninstall omp-codebase-memory
```

Neither touches an adopted system executable, CBM's cache, or any other client's
configuration.

## Staying in step with CBM

The shipped skill, rule, and agents belong to a specific CBM release.
`harvest.json` records which one:

```json
{
  "cbmVersion": "0.10.8",
  "reportedVersion": "codebase-memory-mcp 0.10.8",
  "sourceClients": ["claude", "augment"]
}
```

If you run a newer CBM than that, two detectors tell you, in this order.

**Primary: your own session.** About twenty seconds after a session starts, the
package asks your resolved executable for its MCP tool list and compares it
against the tool names the shipped skill enumerates. A renamed or removed tool
produces one notice naming the tool and your executable's version, and nothing
else — no per-call output, and no second notice. This detector runs on your
machine against the binary you actually have, so it is unaffected by anything
that happens or fails to happen in this repository.

**Secondary: the `harvest` CI job.** It acquires the newest CBM release,
regenerates every artifact, and fails when a committed copy differs. It runs on
pushes, on pull requests, and weekly on a schedule — the schedule because a new
upstream release produces no activity here, so a push-only gate would stay green
while the shipped content went stale.

That schedule has a blind spot nobody can close from inside the repository:
GitHub disables scheduled workflows after prolonged repository inactivity, and
does so silently. A dormant-but-installed package is exactly that state. So the
per-session check is the authoritative one, and the scheduled job is a net
underneath it.

Either way the remedy is the same: update the plugin. The notice reports; it
does not regenerate anything on your machine.

## Requirements

- **Bun**, which is OMP's runtime. No npm runtime dependencies.
- **`tar`** for archive extraction.
- **`xattr` and `codesign`** on macOS. Both ship with a default install; their
  absence is reported as a named prerequisite rather than a mysterious failure.
- macOS and Linux. Windows is deferred, not refused: it needs zip extraction, a
  different executable suffix, and its own path handling, and is currently one
  explicit unsupported-platform error rather than a half-implemented branch.

## Known limits

- **MCP does not pick up a changed `command` without a reload.** A managed
  update changes the resolved path mid-session; the entry is corrected
  immediately and you are told the session needs `/mcp reload`.
- **A foreign entry of the same name is left alone.** If `mcp.json` already
  defines `codebase-memory-mcp` with a `command` this package did not write, the
  file is not modified and both paths are reported. CBM's own installer, another
  tool, or a hand edit may already own that name.
- **`~/.omp/agent/mcp.json` has two possible writers.** OMP's own `/mcp add` and
  this package have no shared lock. The write is a read-modify-write against the
  observed content and fails closed on a shape it does not recognise, so a lost
  update degrades to "the entry is missing and the next session start rewrites
  it" rather than a corrupted file.

## Development

```sh
bun install                # --frozen-lockfile in CI
bun run typecheck
bun run test:unit          # no CBM executable, no network
bun run test:packaging     # rebuilds both bundles, then loads them
bun run build              # commit the result
```

Tests are written as case tables: one row per case, named by a `scenario` field,
so a failure names the case without anyone reading the table.

### Regenerating the context surfaces

```sh
bun run harvest
```

Run it when the CI `harvest` job reports a difference, or when you deliberately
move to a newer CBM. Never edit `skills/`, `rules/`, `agents/`, or `harvest.json`
by hand: a unit test re-runs every build guard against the committed files, and
CI regenerates and diffs them.

The harvest refuses while a CBM daemon is running, because `install` is CBM's
activation path and drains active CBM sessions before it configures anything —
regenerating documentation should not close your editor's MCP connection. Close
those sessions, or accept the consequence explicitly:

```sh
bun run harvest --stop-sessions
```

It needs a CBM executable and therefore a network. The unit suite does not: every
transformation is tested against recorded output under
`test/fixtures/harvest/`, so a contributor with no CBM installed can still run
and extend the whole suite.

## Licence

MIT. See [LICENSE](./LICENSE).

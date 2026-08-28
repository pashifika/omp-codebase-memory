# omp-codebase-memory

Installs and updates [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp)
for [OMP](https://github.com/can1357/oh-my-pi), and wires it into the MCP
configuration your sessions already read.

`codebase-memory-mcp` (CBM) indexes a repository into a persistent code
knowledge graph and serves it over MCP. Its own installer configures dozens of
editor and CLI clients, and OMP is not one of them. On an OMP-only machine, CBM
is reachable only if some *other* client's installation happened to leave a
Claude, Codex, or Gemini config behind for OMP to discover. This extension
supplies that route: one `omp plugin install`, and the graph is reachable, kept
in step, and described to the session that uses it.

## Features

- **System-first resolution:** adopts an existing `codebase-memory-mcp` as it is
  and never replaces it. Downloads a managed copy only when nothing resolves.
- **Verified downloads:** the release tag comes from the `releases/latest`
  redirect, the archive must match its digest in the release's own
  `checksums.txt`, every redirect hop must be HTTPS, the archive's member list
  must be exactly the four expected regular files, and the candidate runs
  `--version` before anything adopts it.
- **One MCP key, kept correct:** `codebase-memory-mcp` is written into the
  active agent directory's `mcp.json` with the resolved absolute path, rewritten
  when that path changes, and removed on uninstall. No other file of yours is
  touched.
- **Versions you control:** update a managed copy from here, pin one to hold it,
  and get a report rather than a surprise when an adopted system copy falls
  behind.
- **Context your session can use:** a skill, a rulebook rule, and three
  read-only agents, all generated from the executable rather than written by
  hand, plus optional graph symbols appended to `grep`, `glob`, and `read`
  results.

## Contents

- [Install](#install)
- [Commands](#commands)
- [Configuration](#configuration)
- [Why a system installation always wins](#why-a-system-installation-always-wins)
- [Graph context in a session](#graph-context-in-a-session)
- [Where things live](#where-things-live)
- [What this package will not touch](#what-this-package-will-not-touch)
- [Staying in step with CBM](#staying-in-step-with-cbm)
- [Known limits](#known-limits)
- [Requirements](#requirements)
- [Development](#development)
- [License](#license)

## Install

Install from the git spec. This is the supported primary route and delivers
every shipped surface:

```bash
omp plugin install github:pashifika/omp-codebase-memory
```

Nothing else is needed. The extension resolves an executable, wires the MCP
entry at the next session start, and tells you what it did.

To install without the optional result augmentation, name an empty feature
selection:

```bash
omp plugin install 'github:pashifika/omp-codebase-memory[]'
```

### Marketplace

The catalog at `.omp-plugin/marketplace.json` makes this repository its own
marketplace, which also enables `omp plugin discover` and `omp plugin upgrade`:

```bash
omp plugin marketplace add pashifika/omp-codebase-memory
omp plugin discover
```

Two things differ on this route:

1. **Installing needs a published release.** The catalog names the tag to
   install, so `omp plugin install omp-codebase-memory@omp-codebase-memory`
   fails with `Remote branch <tag> not found` until that release exists. No
   release is published yet; use the git spec.
2. **It does not deliver the rulebook rule.** Marketplace plugins are discovered
   through a provider that contributes skills and agents but is not a rules
   provider. A rulebook rule is one OMP reads on demand and lists by name rather
   than injecting into every turn, so what it costs a session either way is one
   listed name and description — and the skill carries the same guidance in
   full. The skill, the three agents, the MCP entry, and the augmentation work on
   both routes.

### From a checkout

```bash
git clone https://github.com/pashifika/omp-codebase-memory
cd omp-codebase-memory
bun install
omp plugin link .
```

Both bundles — `dist/index.js` and the feature's `dist/augment.js` — are
committed, so a fresh clone loads with no build step.

### Uninstall

Run `/cbm uninstall` in a session first. It removes the managed copy, this
package's state, and the owned MCP entry. Then remove the plugin:

```bash
omp plugin uninstall omp-codebase-memory
```

Neither touches an adopted system executable, CBM's cache, or any other client's
configuration.

## Commands

Everything is one command with subcommands. `/cbm` on its own reports status.

| Command | What it does |
|---|---|
| `/cbm status` | Reports the resolved executable and where it came from, its version, any managed copy on disk, the last known upstream version, the pin, the resolved agent directory, whether the owned MCP entry is present and current, and which indexed project covers this directory |
| `/cbm install [version]` | Downloads, verifies, and adopts a managed copy. Asks for confirmation first when a system executable already resolves |
| `/cbm update` | Updates a managed copy. For an adopted system copy, reports the newer version and points at CBM's own `update` |
| `/cbm pin <version>` | Holds a version: update checks report but never adopt |
| `/cbm unpin` | Releases the pin |
| `/cbm uninstall` | Removes the managed copy, this package's state, and the owned MCP entry. Leaves an adopted system executable alone |

A status report reads as one labelled line per fact, so a stale MCP entry or an
unindexed directory is visible without running anything else.

No command needs an interactive terminal. In a session with no UI, `/cbm
install` reports the reason and stops rather than waiting for a confirmation
that cannot arrive.

### Indexing is the agent's work

There is no index command here, and that is deliberate. `index_repository` is
already in your model's tool surface, and CBM's own guidance — which this
package ships as the skill and the rule — tells the model to confirm the project
with `list_projects` or `index_status` at session start. So ask the agent to
index the repository. A second path through `/cbm` would duplicate one that
already works, with its own arguments and defaults to drift apart.

## Configuration

This package has one setting, the optional augmentation feature, and it is on by
default:

```bash
omp plugin features omp-codebase-memory --disable graph-augmentation
omp plugin features omp-codebase-memory --enable graph-augmentation
```

The MCP entry is written to the active OMP agent directory, resolved the way OMP
resolves it:

| Setting | Effect |
|---|---|
| `PI_CODING_AGENT_DIR` | Used directly when set. Inside a session this is already OMP's own answer |
| `OMP_PROFILE`, `PI_PROFILE` | Select `~/.omp/profiles/<name>/agent`. `OMP_PROFILE` wins; `PI_PROFILE` is read only when it is unset |
| Neither | `~/.omp/agent` |
| `PI_CONFIG_DIR` | Replaces the `.omp` directory name every path above hangs off |

A profile-scoped setup therefore gets the entry in the active profile only —
writing every profile would configure profiles you never asked about — and
`/cbm status` names the directory it resolved, so the scope is visible.

CBM's own behaviour is CBM's configuration, not this package's. Three of its
defaults decide what you see on a new machine, measured from
`codebase-memory-mcp config list` at 0.10.8:

| Key | Default | What it means |
|---|---|---|
| `auto_index` | `false` | A project is not indexed just because a session connected. The first index is something you or the agent asks for |
| `auto_index_limit` | `50000` | The file ceiling for an automatic index of a new project, when `auto_index` is on |
| `auto_watch` | `true` | Once a project is indexed, a background git watcher is registered on connect, so ongoing freshness needs no action |

The practical shape: the first index is explicit, and staying current after that
is not. Change these through CBM's own `config set`; this package never writes a
CBM configuration key for you.

## Why a system installation always wins

Resolution order is **pin, `PATH`, `~/.local/bin`, managed copy** — system
before managed, and the reason is the index rather than tidiness.

CBM resolves one canonical cache root per account, and refuses to run when a
process is configured against a different root while any CBM session or command
is active. Two executables of different versions sharing that root produce
mismatched index generations. Giving a managed copy a private cache root would
trade the conflict for re-indexing every repository a second time — hours of
work on a large tree, and gigabytes to hold the same answers twice.

So your existing installation wins. The cost is that this package cannot
guarantee a version, and that cost is visible rather than hidden: `/cbm status`
names the source, and an out-of-date system copy produces a pointer to CBM's own
`update` instead of an attempt to perform it.

`/cbm install` while a system copy resolves is still possible — it is your
machine — but it explains the shared-cache-root consequence and requires an
explicit confirmation first.

## Graph context in a session

Five committed files, all generated from the CBM executable by
`bun run harvest`:

| Surface | Path | What a session gets |
|---|---|---|
| Skill | `skills/codebase-memory/SKILL.md` | The tool matrix, the exploration and tracing workflows, the Cypher examples, and the gotchas. Read on demand as `skill://codebase-memory` |
| Rule | `rules/codebase-memory.md` | The priority order and the evidence tiers. Listed in the rulebook by name, read on demand as `rule://codebase-memory` |
| Agents | `agents/codebase-memory{,-scout,-auditor}.md` | CBM's Scout, Verify, and Auditor tiers as read-only subagents |

The agents declare `tools: read, grep, glob` and name no MCP tool, because an
OMP subagent does not inherit one. Their prompts tell the child that the parent
supplies the graph evidence and that the child must verify it against exact
source. Every name carries the `codebase-memory-` prefix, so none of them can
shadow one of OMP's own agents.

### The augmentation feature

With `graph-augmentation` enabled, a `grep` or `glob` result gains the graph
symbols whose names hold one of the identifiers the search used, and a `read`
gains the index's coverage findings for that file — but only when coverage
reports a gap, so a fully indexed file reads exactly as it did before.

Each appended symbol carries its qualified name, label, file, line range, and
the graph's degree, written `11 in / 14 out`. The degree is the part worth the
tokens: how many edges reach a symbol is not something `grep`, `glob`, or
`lsp references` can tell you. It is CBM's selected degree over `CALLS`,
`USAGE`, `CALL_REFERENCE`, `INHERITS`, and `IMPLEMENTS`, not a caller count —
use `trace_path` for callers, which is also the only tool here that answers
transitively.

Four guarantees hold whenever the feature is active:

1. It only ever appends. Every chunk the tool produced reaches the model
   unchanged, including content another extension added first.
2. It never runs on `tool_call`. OMP treats a handler that throws or blocks
   there as a refusal of the tool call, so a slow query could deny your `grep`.
   This one runs on `tool_result`, where a failure is caught and the run
   continues.
3. Every query has a deadline in the low hundreds of milliseconds and a bound on
   how much it may append. A query that misses the deadline appends nothing.
4. An errored tool result is left alone.

It holds one CBM process for the session at about 2.6 MB resident, opened in the
background at session start. Opening it is not instant — roughly 3 seconds
against a warm CBM daemon, about 9 when it has to start the daemon — and a
search never waits for it. Searches issued before the session is ready append
nothing and are otherwise untouched. `~/.omp/logs` records one line per session
saying whether the session became ready and which project it resolved.

## Where things live

| Path | Owner | Notes |
|---|---|---|
| `~/.omp/codebase-memory/bin/<version>/` | this package | Managed executables, one directory per version |
| `~/.omp/codebase-memory/state.json` | this package | Version pointer, digest, pin, last check time |
| `<agent-dir>/mcp.json` | you | This package owns the single `codebase-memory-mcp` key and nothing else in the file |
| `~/.local/bin/codebase-memory-mcp` | CBM's installer | Read during resolution, **never** written |
| `<plugin root>/skills`, `rules`, `agents` | this package | The generated context surfaces, found by OMP's plugin scan and removed with the plugin |
| CBM's cache root and its graph | CBM | Shared with every other client on the account. Nothing here indexes, deletes, or overrides it |

The managed copy lives outside the plugin tree on purpose. OMP caches plugins in
version-qualified directories and replaces them on reinstall, so an executable
stored inside one would be discarded by a routine plugin upgrade and downloaded
again every time.

## What this package will not touch

- **Any executable it did not install.** An installation found on `PATH` or in
  `~/.local/bin` is adopted as it is; `~/.local/bin` belongs to CBM's own
  installer and CBM's `update` owns the file there.
- **Anything in `mcp.json` but its own key.** If that key already names a
  `command` this package did not write, the file is left alone and both paths
  are reported.
- **Your OMP instruction files.** It never creates or edits `AGENTS.md` or
  `RULES.md` in your agent directory. Each is a single slot, so writing one
  would not add to your instructions, it would replace them.
- **CBM's configuration.** No account-wide CBM key is ever set for you.
- **CBM's graph, index, watcher, and cache root.** All CBM's, shared with every
  other client on the account.
- **Your tool calls.** The augmentation registers no `tool_call` handler, so it
  can never refuse or delay a call — only add to a result.

## Staying in step with CBM

The shipped skill, rule, and agents belong to one CBM release. `harvest.json`
records which, and lists every path the pipeline owns:

```json
{
  "cbmVersion": "0.10.8",
  "reportedVersion": "codebase-memory-mcp 0.10.8",
  "sourceClients": ["claude", "augment"]
}
```

If you run a newer CBM than that, two detectors tell you, in this order.

**Your own session, first.** About twenty seconds after a session starts, the
package asks your resolved executable for its MCP tool list and compares it
against the tool names the shipped skill enumerates. A renamed or removed tool
produces one notice naming the tool and your executable's version — once, not
per call. This runs on your machine against the binary you actually have, so
nothing that happens or fails to happen in this repository affects it.

**The scheduled CI job, second.** It acquires the newest CBM release,
regenerates every artifact, and fails when a committed copy differs. It runs on
pushes, on pull requests, and weekly.

The schedule has a blind spot that cannot be closed from inside the repository:
GitHub disables scheduled workflows after prolonged repository inactivity, and
does so silently. A dormant-but-installed package is exactly that state. So the
per-session check is the authoritative one and the scheduled job is a net
underneath it.

Either way the remedy is the same: update the plugin. The notice reports; it
regenerates nothing on your machine.

## Known limits

- **MCP does not pick up a changed `command` without a reload.** A managed
  update changes the resolved path mid-session. The entry is corrected
  immediately and you are told the session needs `/mcp reload`.
- **A foreign entry of the same name is left alone.** CBM's own installer,
  another tool, or a hand edit may already own the `codebase-memory-mcp` key.
- **`mcp.json` has two possible writers.** OMP's `/mcp add` and this package
  share no lock. The write is a read-modify-write against observed content and
  fails closed on a shape it does not recognise, so a lost update degrades to a
  missing entry that the next session start rewrites, never a corrupted file.
- **Windows is unsupported.** It needs zip extraction, a different executable
  suffix, and its own path handling. It is one explicit
  unsupported-platform error rather than a half-implemented branch.

## Requirements

- **Bun.** OMP's own runtime, so you already have it. CI pins 1.3.14, tracked by
  `@types/bun` in `package.json`. No npm runtime dependencies.
- **`tar`**, for archive extraction.
- **`xattr` and `codesign`** on macOS, both from a default install. A missing
  one is reported as a named prerequisite rather than a mysterious failure.
- **macOS or Linux.**

## Development

```bash
bun install                # --frozen-lockfile in CI
bun run typecheck
bun run test:unit          # no CBM executable, no network
bun run test:packaging     # rebuilds both bundles, then loads them
bun run build              # commit the result
```

Run `bun run build` after changing anything under `src/`. CI rejects a committed
bundle that is not byte-identical to one built from the current source.

Tests are written as case tables: one row per case, named by a `scenario` field,
so a failure names the case without anyone reading the table.

Regenerate the context surfaces when the CI `harvest` job reports a difference,
or when you deliberately move to a newer CBM:

```bash
bun run harvest
```

`skills/`, `rules/`, `agents/`, and `harvest.json` are generated; see
[`CLAUDE.md`](CLAUDE.md) for why they are never edited by hand.

The harvest refuses while a CBM daemon is running, because `install` is CBM's
activation path and drains active CBM sessions before it configures anything —
regenerating documentation should not close your editor's MCP connection. Close
those sessions, or accept the consequence explicitly:

```bash
bun run harvest --stop-sessions
```

That command needs a CBM executable and therefore a network. The unit suite does
not: every transformation is tested against recorded output under
`test/fixtures/harvest/`, so a contributor with no CBM installed can still run
and extend the whole suite.

[`CLAUDE.md`](CLAUDE.md) holds the repository's conventions and standing rules.
[`CONTRIBUTING.md`](CONTRIBUTING.md) holds the procedures that need maintainer
credentials.

## License

MIT. See [LICENSE](LICENSE).

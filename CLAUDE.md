# Repository Guidelines

## Authority and scope

`omp-codebase-memory` distributes `codebase-memory-mcp` (CBM) as an installable
OMP extension: it owns the executable's lifecycle, wires one MCP server entry,
and ships context artifacts harvested from that executable. It is TypeScript on
Bun, has no npm runtime dependencies, and commits its bundled entry points at
`dist/index.js` and `dist/augment.js`. `README.md` states what the package does
for an operator; this file does not restate it.

`rasen/specs/` contains the accepted capability specifications and outranks
change proposals. `rasen/changes/` records design decisions and their rationale;
do not duplicate that rationale here. When implementation changes a normative
decision, update the affected specification in the same change.

This file is the authority for repository guidance. `AGENTS.md` is a tracked
symbolic link to it, so both agent tool families read one text; do not create a
second copy of these rules anywhere.

## Repository layout

The working tree contains two independent Git repositories:

- The outer repository tracks code and delivery, including `.github/`, `src/`,
  `test/`, `dist/`, `package.json`, and `.omp-plugin/`.
- `rasen/` tracks planning artifacts in its own repository and remote.

`rasen/` is ignored by the outer repository, so `git status` at the root never
reports its state and it has to be inspected on its own. Commit its work with
`git -C rasen`; never stage planning and implementation in the same repository.

## Git workflow

Never commit implementation to the default branch. Cut a short-lived topic
branch from it before implementation begins, and name it `<type>/<short-slug>`
using the Conventional Commits type that dominates the change. Branches already
landed this way: `feat/graph-context-and-agents`,
`docs/repository-guidelines`, `chore/commit-ruleset-payloads`.

The default branch and release tags are protected by the rulesets committed
under `.github/rulesets/`. This paragraph and the list below it state two things
and no more. First, the shape of that protection: the facts whose change would
change the sequence of steps by which work lands here — what a contributor must
do, which button merges, whether a branch must be current first. Second, the two
literals a ruleset shares with a workflow: the required check name `ci`, which
`main.json` requires and which is the gate job's own name in `ci.yml`, and the
tag pattern `v*`, which `tags.json` protects and which `release.yml` triggers
on. Nothing reads either ruleset file, so neither agreement is checked anywhere;
that is why those two are stated here at all. (The third pairing, between a
pushed tag and `.omp-plugin/marketplace.json`'s `source.ref`, is checked — the
release version gate fails on a mismatch — so it lives in `CONTRIBUTING.md`
with the procedure, not here.)

A value that only tunes a threshold inside a step that stays the same is a
parameter and stays in the rulesets: the actor and bypass lists, the
review-dismissal and code-owner switches, the exemptions. Read those there
rather than trusting a value repeated in prose. The approval count is zero
today, so there is no approval step to describe; were it to change, the list
below would gain one. The shape:

- The default branch rejects deletion and non-fast-forward pushes.
- Landing a change requires a pull request whose review threads are resolved.
- The merge commit is the only permitted merge method.
- Exactly one status check, named `ci`, is required, under a strict policy — so
  a branch must be current with the default branch before it can merge.
- Release tags matching `v*` reject deletion and non-fast-forward pushes.

Change protection by editing those files and reimporting them, never through the
web interface. A rule changed in the browser is invisible to review and is
overwritten by the next import.

The merge-only restriction is pinned rather than preferred. A squash rewrites
the commits a dependent pull request still carries, so every downstream diff
re-inflates with changes that already landed and each dependent branch needs a
rebase per merge. Preserving the commits is what makes a dependent pull-request
chain cheap here: a branch stacked on another stays mergeable while its parent
lands.

Commit messages follow Conventional Commits. Choose commit boundaries for
coherence — one reviewable decision per commit — rather than by file count or
by when the work happened.

## CI and release

Branch protection requires one status check named `ci`. It is the gate job in
`.github/workflows/ci.yml`: it runs under `if: always()`, fails when it
aggregates no jobs, and accepts only successful dependencies. `always()` is
load-bearing, because a skipped required check blocks a pull request instead of
failing it.

- Runtime job names never appear in a ruleset. Adding, removing, or
  restructuring a runtime job means editing the gate's `needs` and nothing else.
  Renaming the gate job silently blocks every merge, with no failing job to
  point at.
- Keep `install-check` outside the gate because it installs by ref and a pull
  request's merge ref does not exist on the remote as an installable ref.
- Every `uses:` reference is pinned to a full 40-hex commit SHA followed by a
  trailing version comment. The `hygiene` job enforces both halves and fails
  when it finds no references to check.
- Default to `permissions: contents: read`, use `persist-credentials: false`,
  and grant `contents: write` only to the release publish job.
- Do not apply `paths` filters to jobs the gate requires.
- Pin Bun and its matching `@types/bun` version exactly. Install with
  `--frozen-lockfile`.
- Run checks through package scripts and print toolchain versions with results.
- Do not add a Node job; Node is not a supported runtime.

`dist/index.js` and the feature entry `dist/augment.js` are committed. CI reads
the bundle list from `package.json`'s extension entries, builds from source, and
compares each result byte-for-byte with its tracked bundle.

A release tag must match `package.json`'s version and both the version and
source ref in `.omp-plugin/marketplace.json`. Create releases only from verified
tags. `CONTRIBUTING.md` holds the procedure.

## Testing and verification

Add deterministic tests for changed behavior. Cover the package boundaries the
change touches: release selection and checksums, archive validation, executable
resolution, MCP-entry ownership, transport security, scheduler behavior, and
handler fail-open paths.

Where a new test belongs:

- `test/unit` by default. It must not require a CBM executable or network
  access. Use recorded fixtures under `test/fixtures` and helpers in
  `test/support`.
- `test/packaging` when the test needs a build or a real load of the bundle. It
  may touch the filesystem.
- A CI job of its own when the check needs a real executable or the network, as
  `harvest` and `install-check` do. Neither suite may acquire either.

Report the commands and revision used for verification. State which relevant
checks were not run and why; never claim an unexecuted check passed.

## Prohibitions

Each entry carries the mechanism that makes it a rule. A prohibition whose
reason reduces to "it breaks things" is removed by the next contributor who
finds it inconvenient.

**Never replace an executable this package did not install.** Adopt an existing
`codebase-memory-mcp` from `PATH` or `~/.local/bin` as it is. Place a managed
copy only under this package's own root, `~/.omp/codebase-memory/bin/<version>/`
(`src/paths.ts`), which is outside both the plugin tree and the agent directory
— OMP replaces version-qualified plugin directories on reinstall, so an
executable stored inside one is discarded and re-downloaded by a routine plugin
upgrade. System installations win because CBM resolves one canonical per-account
cache root and refuses to run when a process is configured against a different
root while any CBM session is active: two executables of different versions
sharing that root produce mismatched index generations. `~/.local/bin` is CBM's
own installer's directory and CBM's `update` owns the file there.

**Own exactly the `codebase-memory-mcp` key under `mcpServers` in the active
agent directory's `mcp.json`, and nothing else in that file.** Upsert it
idempotently, and remove it only while it still matches the package-owned entry.
OMP's own `/mcp add` writes the same file with no lock shared with this package,
so the write is a read-modify-write against observed content that fails closed on
a shape it does not recognise: a lost update degrades to a missing entry the next
session start rewrites, rather than a corrupted file. A `command` under that key
that this package did not write means another installer owns the name, so the
file is left untouched and both paths are reported.

**Never create or modify an operator's OMP agent-directory `AGENTS.md` or
`RULES.md`.** Both are single-slot: the reader takes one file per slot, so
writing either does not add to the operator's instructions, it silently
suppresses them. In the agent directory `AGENTS.md` is the one surviving
user-level context file, and `RULES.md` occupies the single slot reserved for the
operator's sticky rules. This scopes to the operator's runtime directory. It is
explicitly not about this repository's own root `CLAUDE.md` and `AGENTS.md`,
which are project context discovered from a checkout and claim neither slot — a
reader who conflates the two will read the rule as contradicting the file it is
written in.

**Never delete `.omp/`, at either location.** `.omp/` is an OMP directory that
belongs to the operator: `~/.omp/` holds their account configuration, and this
repository's own `<project>/.omp/` holds their project-local `config.yml` and
skills root. Neither may be deleted, and neither becomes deletable because a
verification step is what materialized it. Cleaning up verification scratch
removes exactly the paths that step created, named one by one — never a
containing directory. The loss is silent by mechanism: a global ignore excludes
`/.omp/`, so the directory is untracked, `git status` never reports it missing,
and nothing fails until a later session reads what is no longer there.

The incident behind that entry: verifying an install with `enabledFeatures: []`
needs a plugin root carrying that selection, and one was created under
`<project>/.omp/plugins/`. Cleaning it up took the operator's `config.yml` and
project-local skills root with it, and the loss surfaced a session later as a
skill registry advertising roughly sixty skills while resolving five. The
placement that avoids it is a temporary directory — `mktemp -d`, which is what
CI already uses for a scratch `HOME` — never a path under `<project>/.omp/` or
`~/.omp/`.

**Never register a `tool_call` handler.** OMP treats a handler that throws or
blocks there as a refusal of the tool call, so one slow graph query would deny
the operator's `grep`. Augment successful output through `tool_result`, where a
failure is caught and the run continues; append rather than replace prior
content, and fail open.

**Never call the platform timer globals.** Use the handler context's managed
timers through `src/scheduler.ts`. A raw `setTimeout` callback that throws
escapes handler dispatch entirely and surfaces as a process-level
`uncaughtException`, which OMP's postmortem handler treats as fatal and tears
down the whole session. The context's timers run the callback with handler
isolation, are `unref`'d, and are cleared on `session_shutdown`.

**Never set an account-wide CBM configuration key for the operator.** CBM 0.10.8
exposes six keys through `codebase-memory-mcp config set` — `auto_index`,
`auto_index_limit`, `auto_watch`, `ui-lang`, `ui_enabled`, `ui_port` — and every
one is account-wide; none is scoped to a project or to a client. That store is
shared with every CBM client on the machine, so a key written here silently
changes what another editor's CBM session does. A read-before-write does not
make it reversible: nothing records that this package wrote the key, and another
client may set the same key meanwhile, so the value to put back is not knowable.

**Never duplicate an action CBM's MCP tools already expose, indexing included.**
The model already holds `index_repository`, and a second path through this
package would take its own arguments and defaults — the two diverge, and the
operator cannot tell which one ran.

**Never hand-edit a generated context artifact.** Regenerate with
`bun run harvest`. The source of these artifacts is embedded in the CBM
executable and changes with it, so a hand edit is a second, diverging statement
of the same contract until the next regeneration overwrites it. A unit test
re-runs every build guard against the committed files, and the `harvest` CI job
regenerates and diffs them.

Contributing changes to `DeusData/codebase-memory-mcp` is out of scope; this
package consumes CBM release artifacts. This package owns only the executable it
downloaded and its MCP entry. CBM owns the graph, indexing, the watcher, the
cache root, and updates to a system installation. Windows and changes to any
other operator file are out of scope.

## Documentation

`README.md` is operator-facing and must be created or rewritten through the
`readme-creator` skill, following its phases and scored against its quality
checklist. If that skill cannot be resolved by name, stop; do not edit the README
by hand. `CONTRIBUTING.md` holds only procedures that need maintainer
credentials and links here for every rule.

`AGENTS.md` must remain a tracked symbolic link to `CLAUDE.md`, with `CLAUDE.md`
as the regular file. Both names are needed and neither reader finds the other's
file: Claude Code reads the root `CLAUDE.md`, while OMP's `claude` provider
reads `.claude/CLAUDE.md` and discovers a root `AGENTS.md` through its
standalone provider. Two regular files would satisfy both readers and diverge on
the first one-sided edit.

Do not add `.omp/AGENTS.md`. This repository's `.omp/` is non-empty, so a native
project context file there would win the depth-0 scope and shadow the root file
that both readers already find — replacing one text with a second that only OMP
sees, for no gain.

# Contributing

This file holds only the procedures that cannot be performed without credentials
or permissions a contributor does not have: publishing a release, and changing
branch protection.

[`CLAUDE.md`](CLAUDE.md) is the authority for everything else — branch naming,
Conventional Commits, the CI contract, the action-pinning rules, where a test
belongs, and the standing prohibitions. That file is the authority and this one
does not restate it, because two copies of a rule are two rules.

No Developer Certificate of Origin or `Signed-off-by` trailer is required. This
document is scoped to credentialed procedures, and a sign-off clause would be
the one contributor-facing rule in a document that holds none.

## Publishing a release

A tag is a claim about four things: the tag itself, the package manifest
version, the catalog plugin version, and the catalog's source ref. An operator
installing from the marketplace resolves the last one, so a catalog that lags
the tag installs the previous release under the new version's name.

1. **Make the version locations agree, on the default branch.** Three fields
   must name one version before the tag exists: `version` in `package.json`,
   `plugins[0].version` in `.omp-plugin/marketplace.json`, and
   `plugins[0].source.ref` in the same file, which carries the `v` prefix and
   must equal the tag. Land that through the usual pull request.

2. **Push the tag from the merge commit that carries those versions.**

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

   A `v*` tag cannot be moved or deleted once pushed, so a tag at the wrong
   commit is not recoverable — publish the next patch version instead.

3. **The version gate checks all four names.** `version-gate` in
   `.github/workflows/release.yml` strips the tag's `v`, then compares it against
   the manifest version, the catalog plugin version, and the catalog source ref.
   Each mismatch is reported as its own annotation and the job fails; nothing is
   published.

4. **The same gate a pull request passes runs against the tag.** `release.yml`
   calls `ci.yml` through `workflow_call` rather than copying its jobs, so the
   tagged tree passes the identical checks. `install-check` also runs on a tag
   push — it is skipped on pull requests, so this is where the documented
   `omp plugin install github:pashifika/omp-codebase-memory#<ref>` command is
   verified against the exact ref an operator can install.

5. **The publish job creates the GitHub release.** It runs only after both the
   version gate and the reused checks succeed. It is the one job that elevates to
   `contents: write`, and it runs:

   ```bash
   gh release create "$GITHUB_REF_NAME" --generate-notes --verify-tag
   ```

   `--verify-tag` refuses to create a release for a tag that does not exist on
   the remote, so a release can only ever name a verified ref.

A failed gate leaves the tag in place with no release attached. Fix the
mismatch, land it, and tag the next version; do not attempt to reuse the tag.

## Changing branch protection

Protection is defined by the ruleset files under `.github/rulesets/`, and
[`CLAUDE.md`](CLAUDE.md) states how a change to them is made. The credentialed
half is the last step: importing the edited file through the repository's rules
settings needs admin permission, and until that import runs the landed file and
the enforced rule disagree.

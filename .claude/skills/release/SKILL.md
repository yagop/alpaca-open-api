---
name: release
description: Cut a release — draft a changelog Release, bump package versions via a PR, tag main after merge, watch the npm publish workflow, then finalize the Release. Use when the user asks to release, publish, or cut a new version.
---

You are cutting a release of this repo's two npm packages (`@alpaca-open-api/core` and
`@alpaca-open-api/mcp`). The whole flow is driven through GitHub: a draft Release with a
changelog, a version-bump PR that the user merges, a `v<version>` tag on `main` that triggers
`.github/workflows/release.yml` to publish to npm, and a final Release update.

## Arguments

Invocation: `/release [version]`

- `[version]` is an **optional semver** value (e.g. `1.2.0`, with or without a leading `v`;
  normalize to no leading `v`). Validate it matches `X.Y.Z` (optionally with a `-prerelease`
  suffix); if it doesn't, tell the user and stop.
- If omitted, derive it after finding the last release tag (default: **patch bump** of the last
  version; use minor/major if the user asked for one in prose).

## Preconditions

Check these before doing anything; stop with a clear message if one fails:

1. `gh auth status` — must be authenticated.
2. You are in this git repo and the remote `origin` exists.
3. Fetch first: `git fetch origin main --tags`.
4. Find the last release tag: `LAST=$(git describe --tags --abbrev=0 --match 'v*' origin/main)`.
   If none exists, treat the range below as the full history and require an explicit `[version]`.
5. The chosen version must be **greater than** the last released version and must not already
   exist as a tag or on npm (`npm view "@alpaca-open-api/core@<version>" version`).

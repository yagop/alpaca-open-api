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

## 1. Changelog & draft Release

1. Collect the commits since the last release:
   ```
   git log $LAST..origin/main --no-merges --format='%h %s'
   ```
   (Full history if there is no previous tag.) If the range is empty, tell the user there is
   nothing to release and stop.
2. Write a changelog in markdown from those commits: group into sections like **Features**,
   **Fixes**, **Docs/CI/Chores** based on the subjects (conventional-commit prefixes when
   present, judgement otherwise). Reference PR numbers (`(#N)`) that appear in the subjects.
   Keep it human-readable — summarize, don't just dump `git log`.
3. Create a **draft** GitHub Release now, **without creating the tag** (the tag only comes
   after the version-bump PR is merged):
   ```
   gh release create v<version> --draft --title "v<version>" --notes-file <changelog-file>
   ```
   `--draft` does not create the git tag — the tag is only created when the Release is
   published, and we'll instead push the tag ourselves later so the existing draft simply
   attaches to it.
4. Note the draft Release URL for the final step.

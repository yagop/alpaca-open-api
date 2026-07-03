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

## 2. Version-bump PR

Do the bump in an **isolated worktree** so the user's checkout is untouched:

1. ```
   ROOT="$(git rev-parse --show-toplevel)"
   WT="$(dirname "$ROOT")/$(basename "$ROOT")-release-<version>"
   git worktree add "$WT" -b release-v<version> origin/main
   ```
2. In `$WT`, set `"version": "<version>"` in **all three** `package.json` files — the root,
   `packages/core/package.json`, and `packages/mcp/package.json`. The release workflow fails
   if the tag doesn't match both package versions, so don't skip any.
3. Sanity-check: `cd "$WT" && bun install && bun test` (per repo convention; skip only if the
   user asked for a fast release).
4. Commit and push:
   ```
   git add package.json packages/*/package.json
   git commit -m "chore(release): bump version to <version>"
   git push -u origin release-v<version>
   ```
5. Open the PR:
   ```
   gh pr create --base main --head release-v<version> \
     --title "chore(release): v<version>" \
     --body "Version bump for the v<version> release. Part of the /release flow — tag and npm publish follow after merge."
   ```
6. **Wait until the PR is merged** — merging is the user's call, never merge it yourself.
   Poll `gh pr view <PR> --json state,mergedAt` on a relaxed interval (e.g. every 60s, bounded
   to ~30 min). If it's still open at the bound, tell the user you're waiting on their merge
   (with the PR URL) and stop — the flow can be resumed by re-running `/release <version>`,
   which should detect the already-bumped versions and continue from the tagging step.
   If the PR is **closed without merging**, abort and report.
7. After merge, clean up: `git worktree remove "$WT"` and delete the local branch.

## 3. Tag & publish

1. Fetch and verify the bump landed on main:
   ```
   git fetch origin main
   git show origin/main:packages/core/package.json | grep '"version"'
   ```
   Both packages (and the root) must read `<version>` — if not, the bump PR didn't merge
   cleanly; stop and report.
2. Tag the merged main and push **only that tag** (never push branches here):
   ```
   git tag v<version> origin/main
   git push origin v<version>
   ```
   If the tag already exists locally or remotely pointing at the same commit, that's a resume —
   continue; if it points elsewhere, stop and report rather than moving it.
3. The push triggers `.github/workflows/release.yml`, which checks the tag is on main, builds,
   tests, verifies the tag matches both package versions, and publishes both packages to npm.
   Watch it:
   ```
   gh run list --workflow release.yml --limit 1   # get the run id for the tag
   gh run watch <run-id> --exit-status
   ```
4. If the run **fails**, read `gh run view <run-id> --log-failed` and report the cause. Do not
   delete or move the tag; the workflow's publish steps are re-runnable (`gh run rerun`) once
   the cause is fixed. A version-mismatch failure means step 2 of the flow was skipped.
5. Confirm both packages are live:
   ```
   npm view "@alpaca-open-api/core@<version>" version
   npm view "@alpaca-open-api/mcp@<version>" version
   ```

## 4. Finalize the Release

1. Publish the draft Release so it attaches to the pushed tag:
   ```
   gh release edit v<version> --draft=false --latest
   ```
2. Append links to the published packages at the end of the release notes (keep the existing
   changelog intact):
   ```
   - npm: [@alpaca-open-api/core@<version>](https://www.npmjs.com/package/@alpaca-open-api/core/v/<version>) · [@alpaca-open-api/mcp@<version>](https://www.npmjs.com/package/@alpaca-open-api/mcp/v/<version>)
   ```
   (`gh release view v<version> --json body`, append, then `gh release edit v<version> --notes-file …`.)
3. Report to the user: the Release URL, the tag, and both npm version links.

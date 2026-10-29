---
name: bump-version
description: This skill should be used when the user asks to "bump the version", "release a new version", "update the version number", "prepare a release", "version bump", or needs to determine and apply a semver version increment.
---

# Bump Version

Analyze changes since the last release, propose a semver bump type (major/minor/patch), and apply it using `npm version` after user confirmation.

## Workflow

STOP — Follow these steps in exact order. Do not skip or reorder.

### Step 1: Identify the Latest Version Tag

Find the most recent version tag:

```bash
git describe --tags --abbrev=0 --match "v*" 2>/dev/null || echo "NO_TAG"
```

- If a tag exists, use it as the comparison base.
- If no tag exists, use the initial commit (`git rev-list --max-parents=0 HEAD`) as the base. If there are no commits at all, compare against the empty tree (`4b825dc642cb6eb9a060e54bf899d15363d7c68` — git's empty tree SHA).

### Step 2: Generate the Diff

Get the full diff between the base and the current working tree:

```bash
git diff <base> HEAD
```

Also check for staged/unstaged changes that haven't been committed:

```bash
git status --short
```

If there are uncommitted changes, warn the user that `npm version` requires a clean working tree. Offer to proceed with committed changes only or ask them to commit first.

### Step 3: Analyze Changes and Propose Bump Type

Review the diff and categorize changes using semver rules:

- **major** — Breaking changes: removed or renamed JSON-RPC methods, params or environment variables, changed error code meanings, changed default behavior in incompatible ways, breaking changes to result shapes (fields removed/renamed), raised minimum VS Code version that drops support for existing users
- **minor** — New functionality: new JSON-RPC methods, new optional params, new result fields (additive), new environment variables, new features
- **patch** — Fixes and maintenance: bug fixes, documentation updates, refactoring without behavior change, dependency updates, typo fixes, performance improvements

Present the analysis to the user:
1. Summarize the key changes found in the diff
2. State the proposed bump type with reasoning
3. Show what the new version number will be (read current from `package.json`)

### Step 4: Confirm with User

STOP — Ask the user to confirm before proceeding. Present:
- Current version
- Proposed bump type
- New version number
- Option to choose a different bump type

Do NOT proceed until explicit confirmation.

### Step 5: Update the Changelog

STOP — This step MUST happen before `npm version` so the changelog is included in the version commit.

1. Read `CHANGELOG.md` from the project root.
2. Take everything under the `## [Unreleased]` heading and move it into a new version section.
3. The new section heading must be `## [<new-version>] - <YYYY-MM-DD>` (today's date).
4. Leave `## [Unreleased]` in place but empty (no subsections, no items) so it's ready for future changes.
5. Do NOT change any existing version sections below.

Example before:

```markdown
## [Unreleased]

### Added

- New feature X

## [0.2.0] - 2026-02-16
```

Example after (bumping to 0.3.0 on 2026-02-19):

```markdown
## [Unreleased]

## [0.3.0] - 2026-02-19

### Added

- New feature X

## [0.2.0] - 2026-02-16
```

6. Commit the changelog update along with any other pending changes:

```bash
git add CHANGELOG.md
git commit -m "Update changelog for <new-version>"
```

### Step 6: Apply the Version Bump

Once the changelog is committed, run:

```bash
npm version <major|minor|patch>
```

This command:
- Updates `version` in `package.json` (and `package-lock.json`)
- Creates a git commit with message `v<new-version>`
- Creates a git tag `v<new-version>`

If `npm version` fails due to uncommitted changes, inform the user and suggest committing or stashing changes first.

### Step 7: Report Result

After successful bump, report:
- The new version number
- The git tag created
- Remind to push with tags: `git push && git push --tags`. Pushing the `v*` tag triggers the publish workflow that releases the extension to the VS Code Marketplace.

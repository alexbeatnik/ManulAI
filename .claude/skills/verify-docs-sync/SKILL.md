---
name: verify-docs-sync
description: Pre-commit sanity check for ManulAI docs. Verifies that CLAUDE.md and .github/copilot-instructions.md are byte-identical, that the version string matches across all 6 version-carrying files (package.json, package-lock.json, README.md What's New, README-dev.md Release Notes, CLAUDE.md, .github/copilot-instructions.md), and that the build still compiles. Report-only — never edits files.
---

# verify-docs-sync

Quick structural check that the repository invariants hold. Useful before committing a release bump, or whenever you've touched CLAUDE.md / copilot-instructions / any README to confirm nothing drifted.

## When to invoke

- Before committing a change that touched any of: `CLAUDE.md`, `.github/copilot-instructions.md`, `README.md`, `README-dev.md`, `package.json`, `package-lock.json`.
- After `/bump-version` as a belt-and-suspenders sanity check.
- When the user asks "is everything in sync?" / "перевір чи синхронізовано доки".

## Checks

Run each check independently and report all results, even if an earlier one failed. The user wants the full picture, not an early-exit.

### Check 1: Instructions parity

```bash
diff CLAUDE.md .github/copilot-instructions.md
```

Expected: files are identical. If `diff` prints anything, the check fails — show the full diff in the report.

These two files must stay byte-identical because one is the Claude Code guidance file and the other is the VS Code / GitHub Copilot counterpart; keeping them in sync avoids two different sources of truth.

### Check 2: Version consistency

Read the version from `package.json` (the canonical source), then grep it across the other 5 files:

```bash
CURRENT=$(grep -oP '"version":\s*"\K[0-9]+\.[0-9]+\.[0-9]+' package.json | head -1)
grep -n "$CURRENT" package-lock.json README.md README-dev.md CLAUDE.md .github/copilot-instructions.md
```

Expected hits (minimum):
- `package-lock.json` — **2** hits (top-level + `packages.""`).
- `README.md` — at least 1 hit in `## What's New`.
- `README-dev.md` — at least 1 hit in `## Release Notes`.
- `CLAUDE.md` — 1 hit at the top (`Version: <X>`).
- `.github/copilot-instructions.md` — 1 hit at the top.

Also confirm no **older** version appears where the current version should be — e.g. `package-lock.json` still showing 0.0.11 when `package.json` is 0.0.12 is a common drift (npm install forgot to update, or version bump skipped the lockfile).

### Check 3: Build still compiles

```bash
npm run compile 2>&1 | tail -20
```

Expected: no TypeScript errors. If compile fails, the docs might be fine but the release is not shippable — flag both.

If `node_modules/` is missing, report that the user needs to run `npm install` first; do NOT silently install (installing pulls ~470 packages and modifies `package-lock.json`).

## Report format

Print a compact status block:

```
[1/3] Instructions parity (CLAUDE.md ≡ copilot-instructions.md): ✓ / ❌
[2/3] Version consistency (all 6 files at <version>):           ✓ / ❌
[3/3] Build (npm run compile):                                  ✓ / ❌
```

For each ❌, inline the concrete delta: the diff output, the mismatched file(s) and lines, or the compile error. Do not make the user re-run anything to see what's wrong.

## What this skill must NOT do

- **Never edit files.** This is a read-only audit. If sync drift is found, report it and let the user (or `/bump-version`) fix it. Silently "fixing" the drift hides the real bug that produced it.
- Do not run `npm install` — installs are side-effects the user should authorize explicitly.
- Do not stop at the first failure. All three checks run regardless.

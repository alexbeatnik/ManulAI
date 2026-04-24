---
name: bump-version
description: Atomically bump the ManulAI extension version across all 6 required locations (package.json, package-lock.json ×2 occurrences, README.md What's New, README-dev.md Release Notes, CLAUDE.md, .github/copilot-instructions.md) and verify the build still compiles. Enforces the CLAUDE.md rule that packaging version changes update every one of these files in the same change.
---

# bump-version

The CLAUDE.md Documentation rule says: *"When packaging version changes, update `package.json`, `package-lock.json`, `README.md`, and `README-dev.md` in the same change."* In practice the version also lives in `CLAUDE.md` and `.github/copilot-instructions.md`. Miss any of these and the release is inconsistent.

## When to invoke

- User says "bump to 0.0.X" / "онови версію" / "new release".
- User asks to cut a release and the current version in `package.json` is the already-shipped one.

Do NOT invoke just because the user said "update the docs" — that's a docs-only change, version stays put.

## Inputs

- `args` form: `<new-version> <one-line-summary>` — e.g. `/bump-version 0.0.13 Agent recovery hardening and read-loop nudge accuracy fix`.
- If `args` is empty or missing the summary: ask the user for both before touching any file. Never invent a version number or a release summary.

## The 6 locations

Grep the current version first to confirm everything is consistent before bumping:

```bash
grep -n "<current-version>" package.json package-lock.json README.md README-dev.md CLAUDE.md .github/copilot-instructions.md
```

Expected hits:
1. `package.json` — `"version": "<current>"`
2. `package-lock.json` — **two** occurrences (top-level `version` and `packages.""` `version`). Both must change.
3. `README.md` — latest bullet in the `## What's New` section starts with `- **<current>:**`. Do not replace it; insert the new version as a NEW first bullet above it.
4. `README-dev.md` — same pattern in `## Release Notes`. Insert new bullet above the current one.
5. `CLAUDE.md` — `Version: <current>` at the top.
6. `.github/copilot-instructions.md` — same `Version: <current>` at the top (this file must stay identical to CLAUDE.md).

## Execution order

1. **Read the current state.** Grep the current version in all 6 files and confirm they match. If any file lags behind (e.g. package-lock out of sync), fix the lag as part of the bump — don't bump on an inconsistent base.
2. **Write the code changes first**, if any shipped in this release. Bumping version without real shipped changes is meaningless.
3. **Run `npm run compile`** before touching version strings. If the build is broken you cannot release; abort and surface the compile error.
4. **Edit the 6 files.** Use `Edit` with `replace_all=false` and full context so the right occurrence is matched. For package-lock.json's two occurrences, use a single block with both lines in the `old_string` to anchor them together.
5. **Add the new release note.** In `README.md`, insert a new `- **<new>:** <summary>...` bullet as the first child of `## What's New`. In `README-dev.md`, mirror this in `## Release Notes` with the same bullet plus sub-bullets for the concrete code paths touched (file names, function names, the actual mechanism of the fix — not marketing prose).
6. **Re-run `npm run compile`** to confirm nothing regressed during edits.
7. **Run `diff CLAUDE.md .github/copilot-instructions.md`** — must print "identical".
8. **Re-grep the new version in all 6 files** to confirm everything is consistent.
9. **Report `git diff --stat`** so the user sees exactly what moved.

## Writing the release note

The README.md user-facing bullet is one paragraph, technical tone, alpha-stage (no marketing). Match the style of the existing 0.0.12 / 0.0.11 / 0.0.10 entries — describe the *mechanism* of the fix, not just the symptom.

The README-dev.md entry is the same first-line plus structured sub-bullets: one sub-bullet per concrete code change, naming the file, function, and what the mechanism is. Do not duplicate the user-facing README wording verbatim — dev docs are denser.

Do NOT write:
- "Improved reliability" (vague)
- "Various bug fixes" (no signal)
- "Better user experience" (marketing)

Do write:
- "`recoverRequestScopedCreateTargetPath` now short-circuits unless `currentRequestIsExplicitCreateOnly || currentRequestIsPreferredGreenfield || isLargeRefactorScenario()`"
- "Read-loop nudge requires `successfulReadOps > 0`"

## Common mistakes to avoid

- Forgetting package-lock.json has **two** occurrences of the version string.
- Editing the `CLAUDE.md` version but not `.github/copilot-instructions.md` (or vice versa) — they must stay byte-identical.
- Replacing the previous `What's New` bullet instead of prepending a new one above it.
- Claiming a bump without running the build. A version bump on a broken build is a worse signal than no bump.
- Skipping the re-grep at the end. The whole point of the skill is catching the one place you forgot.

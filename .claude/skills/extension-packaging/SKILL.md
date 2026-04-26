---
name: extension-packaging
description: Guidelines for versioning, packaging, and releasing the ManulAI VS Code extension. Covers version bumps, VSIX builds, documentation sync, and release checks.
---

# extension-packaging

This skill governs how ManulAI is versioned, packaged, and released as a `.vsix` file.

## Scope

- `package.json` — version, engine requirements, contributions.
- `package-lock.json` — lockfile version parity.
- `README.md` — user-facing changelog (`## What's New`).
- `README-dev.md` — developer release notes (`## Release Notes`).
- `CLAUDE.md` — version header.
- `.github/copilot-instructions.md` — must stay byte-identical to `CLAUDE.md`.
- `AGENTS.md` — version and feature sync.

## Rules

1. **Six-file version invariant.** When the version changes, ALL of these files must update atomically:
   - `package.json`
   - `package-lock.json` (two occurrences: top-level + `packages.""`)
   - `README.md` (`## What's New` first bullet)
   - `README-dev.md` (`## Release Notes` first bullet)
   - `CLAUDE.md` (`Version: X` at top)
   - `.github/copilot-instructions.md` (identical to CLAUDE.md)
   - `AGENTS.md` (if version or features changed)
2. **Prepend, don't replace.** Add the new version bullet ABOVE the previous one in both README files. Never overwrite the existing changelog.
3. **Build before bump.** Run `npm run compile` before editing version strings. If the build is broken, abort the bump.
4. **Build after bump.** Re-run `npm run compile` after all edits to confirm nothing regressed.
5. **CLAUDE.md parity.** `diff CLAUDE.md .github/copilot-instructions.md` must produce no output. These files are kept byte-identical intentionally.
6. **VSIX build.** Use `npx vsce package --no-yarn` to produce the `.vsix`. The prepublish script runs `npm run compile` automatically.
7. **No silent fixes.** If version sync drift is found, report it and let the user fix it. Do not silently patch one file without updating the others.

## Version bump checklist

```bash
# 1. Confirm current version is consistent
grep -n "0.0.X" package.json package-lock.json README.md README-dev.md CLAUDE.md .github/copilot-instructions.md

# 2. Build must pass
npm run compile

# 3. Edit all 6+ files with the new version

# 4. Build again
npm run compile

# 5. Verify CLAUDE.md parity
diff CLAUDE.md .github/copilot-instructions.md

# 6. Re-verify version grep
grep -n "0.0.Y" package.json package-lock.json README.md README-dev.md CLAUDE.md .github/copilot-instructions.md

# 7. Package
npx vsce package --no-yarn
```

## Common mistakes

- Forgetting `package-lock.json` has TWO version occurrences.
- Updating `CLAUDE.md` but not `.github/copilot-instructions.md`.
- Replacing the previous changelog bullet instead of prepending.
- Bumping version without a real code change to ship.
- Skipping the post-bump compile check.

## Release note style

**README.md** (user-facing): one paragraph, technical tone, alpha-stage. Describe the mechanism of the fix, not just the symptom.

**README-dev.md** (developer): same first-line plus structured sub-bullets naming files, functions, and mechanisms.

Do NOT write vague marketing text like "Improved reliability" or "Various bug fixes".

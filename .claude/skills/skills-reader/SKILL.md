---
name: skills-reader
description: Guidelines for modifying the workspace skills reader in src/skillsReader.ts. Covers skill discovery, frontmatter parsing, and injection into the Copilot Chat system prompt.
---

# skills-reader

`skillsReader.ts` discovers and reads skill files from workspace skill directories and injects them into the Copilot Chat system prompt.

## Scope

- `src/skillsReader.ts` — skill discovery, frontmatter parsing, and formatting utilities.
- `src/copilotChatParticipant.ts` — consumer that injects skills into the system prompt.

## Search paths

The reader scans these glob patterns across all workspace folders:

1. `.claude/skills/**/*.md`
2. `skills/**/*.md`
3. `.github/skills/**/*.md`
4. `.ai/skills/**/*.md`

Each matching file is treated as a skill. Files in `node_modules` are excluded.

## Skill file format

Each skill file must be a markdown file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: Short description of what this skill covers
---

# my-skill-name

Skill content here. Rules, guidelines, conventions, etc.
```

- `name` — used as the skill heading in the system prompt.
- `description` — optional, shown in `/skills` preview.
- Body — injected verbatim after the frontmatter is stripped.

## Rules

1. **Auto-inject on every chat.** When the participant builds the Ollama message list, it calls `readWorkspaceSkills()` before the system prompt is finalized. All found skills are appended with source attribution.
2. **No caching.** Skills are read fresh on every message so live edits take effect immediately.
3. **Frontmatter parsing.** `parseFrontmatter()` extracts `name` and `description` from the `--- ... ---` block. If frontmatter is missing, the directory name is used as the skill name.
4. **Silent on missing files.** If no skill directories exist, the chat proceeds normally.
5. **Deduplication.** The same file URI is never injected twice, even if it matches multiple patterns.
6. **Size limits.** There is no automatic truncation yet; very large skill files will consume context window.

## Slash command

`/skills` — shows the user a list of loaded skills with names, sources, and descriptions.

## Common mistakes

- Forgetting YAML frontmatter in skill files — the parser will fall back to directory name but description will be empty.
- Expecting skills to persist across VS Code restarts — they are read from disk every time.
- Adding a pattern that matches non-skill markdown files (e.g., `**/*.md` at root) — would pollute the system prompt.

## Testing

Test by:
1. Creating `.claude/skills/test-skill/SKILL.md` with frontmatter and content.
2. Typing `@manulai /skills` and confirming the skill appears.
3. Typing `@manulai hello` and confirming the response follows the skill's rules.
4. Renaming the skill directory and confirming it is still found.

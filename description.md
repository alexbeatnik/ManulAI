# ManulAI — Local AI Coding Assistant

**ManulAI** is a privacy-first, local AI coding assistant for VS Code that runs entirely on your machine via Ollama. It integrates natively as a Copilot Chat participant (`@manulai`) — no cloud APIs, no telemetry, no data leaves your computer.

## Key Features

- **Local-First Architecture** — All model inference runs through your local Ollama instance (`http://localhost:11434`). Works offline and air-gapped.
- **Three Working Modes** — Chat (Q&A), Agent (autonomous file editing + terminal commands), and Planner (step-by-step task execution).
- **Native Copilot Chat Integration** — Type `@manulai` directly in the VS Code Chat panel. Streaming responses with live reasoning extraction from thinking models (`<think>` tags).
- **Tool Execution** — Create/edit/replace files, run terminal commands, read file slices, scan workspace, delete files — all with human-friendly output and safety guards.
- **Safety Hardening** — Blocks dangerous terminal commands (`rm -rf /`, `sudo`, `shutdown`, etc.) and protects critical project files (`.git/`, `package.json`, `.env`, `LICENSE`, etc.) from accidental overwrites or deletion.
- **Context Management** — Automatic conversation compaction via Ollama summarization when context windows fill up. Preserves critical decisions across long sessions.
- **Workspace Awareness** — Auto-reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and workspace skills from `.claude/skills/` directories into the system prompt.
- **Debug Logging** — Structured JSONL logs (`.manulai/logs/`) for tracing requests, tool executions, context trims, and agent loop decisions.

## Tech Stack

- TypeScript (strict), VS Code Extension API
- Ollama `/api/chat` with NDJSON streaming
- Zero external dependencies (air-gap compatible)

## Status

Alpha — APIs and behavior may change. Built for developers who want AI assistance without sacrificing privacy.

# ManulAI

![Alpha](https://img.shields.io/badge/status-alpha-bf5b04)
![Manul Product Line](https://img.shields.io/badge/product%20line-Manul-111827)

ManulAI is a privacy-first local coding agent for Visual Studio Code powered entirely by your own Ollama runtime.

It is built for people who want an AI helper directly inside the editor without cloud APIs, remote inference, or account-based workflow. ManulAI keeps the chat interface inside VS Code, forwards workspace context to Ollama, and supports native tool-calling flows for reading files, editing files, and running local commands.

> The Manul goes hunting and never returns without its prey.

> **Status: Alpha.**
> **Developed by a single person.**
>
> ManulAI is already useful for real work, but it is still being battle-tested on real-world projects. Bugs, rough edges, and behavioral changes are expected while the product matures. The priority is transparent local behavior, predictable tool execution, and strong Ollama-first integration rather than polished marketing promises.

---

## Why Use ManulAI

ManulAI is designed for developers who already want Ollama as the model runtime and need a practical AI assistant inside VS Code:

- local-first by default
- no cloud AI dependency or remote model API
- chat and tools stay close to the code you are editing
- works across any programming language opened in VS Code
- keeps attached file context and conversation history available during the session

---

## Extension Features

> Local Ollama chat, workspace-aware context, native tool execution, and a right-side chat panel designed for day-to-day coding work.

### 💬 Native Chat In VS Code

- dedicated ManulAI chat view in the Secondary Sidebar
- right-side layout keeps the main editor and explorer intact
- in-memory conversation history used as ongoing request context

### 🛠️ Ollama Native Tool Calling

ManulAI is built around Ollama native tool calling through `/api/chat`.

- reads files from the current workspace
- edits files directly from approved tool calls
- runs local terminal commands when needed
- returns tool results through the native `tool` role flow

### 📂 File Context Attachment

- attach the active editor file to the chat
- attach files from the Explorer context menu
- keep dropped file context visible in the UI
- forward file content into the model context cleanly

### ⚙️ Focused Local Configuration

The extension exposes local settings for the Ollama workflow:

- `manulai.ollamaBaseUrl`
- `manulai.ollamaModel`
- `manulai.agentMode`
- `manulai.autoApprove`
- `manulai.systemPrompt`

---

## What Makes It Different

- built specifically as an AI assistant for Ollama inside VS Code
- keeps the chat view in the Secondary Sidebar instead of replacing the main layout
- stays local-first and avoids cloud-connected AI features
- works as a coding agent, not just a plain text chatbot
- supports file context, file editing, and terminal actions in one flow

---

## Notes

- the default model is `llama3.2`
- the default Ollama base URL is `http://localhost:11434`
- `icon.png` is used as the extension icon in the VS Code manifest
- `media/manulai-icon.svg` is used for the contributed sidebar container and view icon

---

## What's New

- **0.0.1 (Alpha Release):** Initial public alpha with right-side chat UI, local Ollama integration, workspace file attachments, and native tool-calling support.

## License

This project is licensed under the Apache License 2.0.
See the `LICENSE` file included in the extension package for details.
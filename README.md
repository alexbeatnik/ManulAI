# ManulAI Local Agent

Version: 0.0.1

ManulAI is a local-first VS Code extension that provides an AI chat assistant powered by Ollama.
The extension runs against a local Ollama instance and is designed for private code assistance inside VS Code.
`icon.png` is used as the extension icon bundled inside the VSIX.

## Current Scope

- Activity Bar launcher icon for quick access
- Right-side chat view in the Secondary Sidebar
- Webview-based chat UI with desktop drag-and-drop file context
- Explorer and editor commands for attaching files to chat context
- Ollama model picker in the chat UI and command palette
- In-memory conversation history
- Native Ollama tool-calling loop
- File reading, file writing, and terminal command execution tools

## Project Structure

```text
.
├── media/
│   ├── manulai-icon.svg
│   └── webview.html
├── src/
│   ├── extension.ts
│   └── ManulAiChatProvider.ts
├── icon.png
├── package.json
└── tsconfig.json
```

## Extension Icon

- `icon.png` is used as the extension icon in the VS Code manifest.
- `media/manulai-icon.svg` is used for the contributed sidebar view container and view icon.

## Requirements

- VS Code 1.112 or newer
- Node.js 18+
- Local Ollama server running at `http://localhost:11434`
- A locally available Ollama model, for example `llama3.2`

## Installation

```bash
npm install
```

After installing the extension in VS Code, run the `ManulAI: Open Chat` command.
The command opens the Secondary Sidebar on the right and reveals the `ManulAI` chat view.
The `ManulAI` icon is also visible in the left Activity Bar as a launcher.
If the right panel is hidden, run `ManulAI: Open Secondary Sidebar`.

## Development

Build the extension:

```bash
npm run compile
```

Run in watch mode:

```bash
npm run watch
```

## Configuration

The extension exposes these settings:

- `manulai.ollamaBaseUrl`
- `manulai.ollamaModel`
- `manulai.systemPrompt`

You can switch the active Ollama model in two ways:

- Use the model selector at the top of the chat view.
- Run `ManulAI: Select Ollama Model` from the Command Palette.

## Notes

- The chat view is contributed to the Secondary Sidebar, not the standard left sidebar.
- Attached files are injected into model context before requests are sent to Ollama.
- Files from the system file manager can be dragged into the webview. Files from the VS Code Explorer should be attached with `Attach to ManulAI Chat`, the Explorer title action `Attach Explorer Selection to ManulAI Chat`, or `ManulAI: Attach Active File to ManulAI Chat`.
- Tool execution currently uses a basic safety filter for shell commands.

## License

This project is licensed under the Apache License 2.0.
See the `LICENSE` file included in the extension package for details.
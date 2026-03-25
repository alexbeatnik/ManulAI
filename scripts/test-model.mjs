// Quick test: send a request directly to Ollama to check if model works
const model = process.argv[2] || 'qwen2.5-coder:7b';
const prompt = process.argv[3] || 'Write hello world in JavaScript';
const mode = process.argv[4] || 'plain'; // plain | tools | tools9 | agent

const SYSTEM_PROMPT = `You are ManulAI, a local VS Code coding agent.
You execute tasks using tools. Never describe what you intend to do instead of doing it.
Call the appropriate tool immediately. No preamble.`;

const FULL_TOOLS = [
  { type: 'function', function: { name: 'list_workspace_files', description: 'List files and folders in a directory.', parameters: { type: 'object', properties: { directory: { type: 'string', description: 'Directory path relative to workspace root' } }, required: ['directory'] } } },
  { type: 'function', function: { name: 'project_scan', description: 'Get a recursive tree of the entire workspace.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'read_workspace_notes', description: 'Read workspace notes.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'write_workspace_notes', description: 'Write workspace notes.', parameters: { type: 'object', properties: { content: { type: 'string' }, mode: { type: 'string', enum: ['append', 'overwrite'] } }, required: ['content', 'mode'] } } },
  { type: 'function', function: { name: 'read_file_slice', description: 'Read a line range from a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['filepath', 'startLine', 'endLine'] } } },
  { type: 'function', function: { name: 'read_specific_file', description: 'Read entire file contents.', parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] } } },
  { type: 'function', function: { name: 'create_or_edit_file', description: 'Create or overwrite file with content.', parameters: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } }, required: ['filename', 'content'] } } },
  { type: 'function', function: { name: 'replace_in_file', description: 'Replace text in a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['filepath', 'old_text', 'new_text'] } } },
  { type: 'function', function: { name: 'execute_terminal_command', description: 'Execute shell command.', parameters: { type: 'object', properties: { command: { type: 'string' }, directory: { type: 'string' } }, required: ['command'] } } },
];

const ONE_TOOL = [FULL_TOOLS[6]]; // create_or_edit_file only

const body = {
  model,
  stream: false,
  messages: []
};

if (mode === 'agent') {
  body.messages.push({ role: 'system', content: SYSTEM_PROMPT });
}
body.messages.push({ role: 'user', content: prompt });

if (mode === 'tools') body.tools = ONE_TOOL;
if (mode === 'tools9') body.tools = FULL_TOOLS;
if (mode === 'agent') body.tools = FULL_TOOLS;

console.log(`Model: ${model} | Mode: ${mode} | Prompt: ${prompt.substring(0, 80)}`);
const t0 = Date.now();

const res = await fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  body: JSON.stringify(body)
});
const d = await res.json();
const dur = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`Time: ${dur}s | Content: ${d.message?.content?.length ?? 0} chars | Tool calls: ${d.message?.tool_calls?.length ?? 0}`);
if (d.message?.content) {
  console.log('---');
  console.log(d.message.content.substring(0, 600));
}
if (d.message?.tool_calls?.length) {
  console.log('--- TOOL CALLS ---');
  for (const tc of d.message.tool_calls) {
    console.log(JSON.stringify(tc, null, 2));
  }
}

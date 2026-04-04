// Quick test: send a request directly to Ollama to check if model works
const model = process.argv[2] || 'qwen2.5-coder:7b';
const prompt = process.argv[3] || 'Write hello world in JavaScript';
const mode = process.argv[4] || 'plain'; // plain | tools | tools9 | agent

const SYSTEM_PROMPT = `You are ManulAI, a local VS Code coding agent.
You execute tasks using tools. Never describe what you intend to do instead of doing it.
Call the appropriate tool immediately. No preamble.`;

const SYSTEM_PROMPT_TEXT_TOOLS = `You are ManulAI, a local VS Code coding agent.
You execute tasks by calling tools. Output tool calls as JSON objects using this format:
{"tool": "tool_name", "args": {"param": "value"}}
Available tools:
- create_or_edit_file(filename, content) - Create or edit a file
- read_specific_file(filepath) - Read file contents
- list_workspace_files(directory) - List files in directory
- execute_terminal_command(command) - Run a shell command
Never describe what you will do. Call the tool immediately using JSON format.`;

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
  num_ctx: 8192,
  messages: []
};

if (mode === 'agent') {
  body.messages.push({ role: 'system', content: SYSTEM_PROMPT });
}
if (mode === 'agent-text') {
  body.messages.push({ role: 'system', content: SYSTEM_PROMPT_TEXT_TOOLS });
}
body.messages.push({ role: 'user', content: prompt });

if (mode === 'tools') body.tools = ONE_TOOL;
if (mode === 'tools9') body.tools = FULL_TOOLS;
if (mode === 'agent') body.tools = FULL_TOOLS;

// thinking models (gemma4, deepseek-r1, etc.) need think:false for tool calling
const thinkingFamilies = /^gemma4(?:[:]|$)|^deepseek-r1(?:[:]|$)/i;
if (thinkingFamilies.test(model) && body.tools) {
  body.think = false;
}

const thinkParam = process.env.THINK; // override via env: THINK=true or THINK=false
if (thinkParam !== undefined) {
  body.think = thinkParam === 'true';
}

console.log(`Model: ${model} | Mode: ${mode} | Think: ${body.think ?? 'default'} | Prompt: ${prompt.substring(0, 60)}`);
const t0 = Date.now();

const res = await fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  body: JSON.stringify(body)
});
const d = await res.json();
const dur = ((Date.now() - t0) / 1000).toFixed(1);

const thinking = d.message?.thinking;
console.log(`Time: ${dur}s | Content: ${d.message?.content?.length ?? 0} chars | Tool calls: ${d.message?.tool_calls?.length ?? 0} | Thinking: ${thinking ? thinking.length + ' chars' : 'none'}`);
console.log('RAW message:', JSON.stringify(d.message, null, 2).substring(0, 800));
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
if (d.error) {
  console.log('--- ERROR ---', d.error);
}

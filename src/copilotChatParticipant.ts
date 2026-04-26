import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OllamaStreamParser } from './ollamaStreamParser';
import type { OllamaStreamChunk } from './ollamaStreamParser';
import { readAgentInstructions, formatInstructionsForPrompt } from './agentInstructionsReader';
import { readWorkspaceSkills, formatSkillsForPrompt } from './skillsReader';
import { getMaxPromptTokens, estimateTokens } from './modelContextConfig';
import {
  getAgentToolInstructions,
  extractToolCallsFromText,
  stripToolCallsFromText,
  executeTool,
} from './agentExecutor';
import type { AgentMessage } from './agentExecutor';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
}

export interface ManulAiChatParticipantOptions {
  output?: vscode.OutputChannel;
  extensionContext?: vscode.ExtensionContext;
}

export class ManulAiChatParticipant {
  private parser = new OllamaStreamParser();
  private output?: vscode.OutputChannel;
  private readonly globalState?: vscode.Memento;
  private static readonly AUTO_APPROVE_KEY = 'manulai.autoApproveState';
  private static readonly AGENT_MODE_KEY = 'manulai.agentModeState';
  private debugMode = false;
  private debugLogFilePath?: string;

  constructor(options?: ManulAiChatParticipantOptions) {
    this.output = options?.output;
    this.globalState = options?.extensionContext?.globalState;
  }

  private getAutoApprove(): boolean {
    // Agent mode defaults to auto-approve for file modifications
    const mode = this.getAgentMode();
    const stored = this.globalState?.get<boolean>(ManulAiChatParticipant.AUTO_APPROVE_KEY);
    if (stored === undefined) {
      return mode === 'agent'; // Default: agent=true, planner/chat=false
    }
    return stored;
  }

  private async setAutoApprove(value: boolean): Promise<void> {
    await this.globalState?.update(ManulAiChatParticipant.AUTO_APPROVE_KEY, value);
  }

  private getAgentMode(): string {
    return this.globalState?.get<string>(ManulAiChatParticipant.AGENT_MODE_KEY) ?? 'agent';
  }

  private async setAgentMode(value: string): Promise<void> {
    await this.globalState?.update(ManulAiChatParticipant.AGENT_MODE_KEY, value);
  }

  private log(msg: string): void {
    this.output?.appendLine(msg);
  }

  private initDebugLog(): void {
    if (!this.debugMode || this.debugLogFilePath) { return; }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return; }
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logDir = path.join(workspaceRoot, '.manulai', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    this.debugLogFilePath = path.join(logDir, `${timestamp}.jsonl`);
    this.debugLog('session_start', {
      model: this.getSelectedModel(),
      agentMode: this.getAgentMode(),
      autoApprove: this.getAutoApprove(),
    });
  }

  private debugLog(event: string, data: Record<string, unknown>): void {
    if (!this.debugMode || !this.debugLogFilePath) { return; }
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...data,
    };
    try {
      fs.appendFileSync(this.debugLogFilePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Ignore log write failures
    }
  }

  private getSelectedModel(): string {
    const config = vscode.workspace.getConfiguration('manulai');
    return String(config.get('ollamaModel', '')).trim();
  }

  private redactArgsForLog(args: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && (key === 'content' || key === 'new_text' || key === 'old_text' || key === 'text')) {
        redacted[key] = value.length > 80 ? value.substring(0, 80) + '…' : value;
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  /**
   * Detects the language ID from a file path for syntax highlighting.
   */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      'ts': 'typescript', 'tsx': 'typescript',
      'js': 'javascript', 'jsx': 'javascript',
      'py': 'python', 'go': 'go', 'rs': 'rust',
      'java': 'java', 'kt': 'kotlin', 'cs': 'csharp',
      'cpp': 'cpp', 'c': 'c', 'h': 'c',
      'html': 'html', 'css': 'css', 'scss': 'scss',
      'json': 'json', 'md': 'markdown', 'yml': 'yaml',
      'yaml': 'yaml', 'sh': 'bash', 'bash': 'bash',
      'sql': 'sql', 'xml': 'xml',
    };
    return map[ext] ?? '';
  }

  /**
   * Compacts conversation history by asking Ollama to summarize old messages.
   * Returns a single compact message that replaces the dropped history.
   */
  private async compactMessagesWithOllama(
    messagesToCompact: ChatMessage[],
    baseUrl: string,
    model: string,
    abort: AbortController
  ): Promise<string> {
    if (messagesToCompact.length === 0) { return ''; }
    const summaryPrompt = messagesToCompact
      .map(m => `[${m.role}${m.tool_name ? `/${m.tool_name}` : ''}]: ${m.content.substring(0, 800)}`)
      .join('\n---\n');

    const summaryMessages: ChatMessage[] = [
      { role: 'system', content: 'Summarize the following conversation history into 2-4 concise sentences. Focus on: key files modified, important decisions made, critical errors encountered, and any unfinished work. Be extremely brief.' },
      { role: 'user', content: summaryPrompt },
    ];

    try {
      const summary = await this.callOllamaNonStream(baseUrl, model, summaryMessages, abort);
      return summary.trim();
    } catch {
      // If compaction fails, return empty so truncation falls back to dropping
      return '';
    }
  }

  /**
   * Truncates message history to fit within the model's context window.
   * First tries to compact dropped history via Ollama summarization.
   * Always preserves the system prompt (index 0) and the latest user message (last index).
   */
  private async truncateMessagesToFit(
    messages: ChatMessage[],
    model: string,
    baseUrl: string,
    abort: AbortController
  ): Promise<ChatMessage[]> {
    if (messages.length <= 2) {
      return messages;
    }

    const maxTokens = getMaxPromptTokens(model);
    const totalTokens = messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0
    );

    if (totalTokens <= maxTokens) {
      this.log(`[context] ${totalTokens} tokens / ${maxTokens} max — no truncation needed`);
      this.debugLog('context_check', { totalTokens, maxTokens, messageCount: messages.length, truncated: false });
      return messages;
    }

    const system = messages[0];
    const currentUser = messages[messages.length - 1];
    let history = messages.slice(1, -1);

    // Try progressive compaction: drop oldest pairs and compact them into a summary
    const compactedSummaries: string[] = [];
    while (history.length > 0) {
      const trimmed = [system, ...history, currentUser];
      const tokens = trimmed.reduce(
        (sum, m) => sum + estimateTokens(m.content),
        0
      );
      if (tokens <= maxTokens) {
        const dropped = messages.length - trimmed.length;
        const resultMessages: ChatMessage[] = [system];
        // Add any compacted summaries as a single system message
        if (compactedSummaries.length > 0) {
          resultMessages.push({
            role: 'system',
            content: `[Previous conversation summarized]: ${compactedSummaries.join(' ')}`,
          });
        }
        resultMessages.push(...history, currentUser);
        this.log(`[context] truncated ${dropped} old message(s)${compactedSummaries.length > 0 ? ' with compaction' : ''}; now ${tokens} tokens / ${maxTokens} max`);
        this.debugLog('context_trim', {
          maxTokens,
          totalTokens,
          messageCount: messages.length,
          trimmedTo: resultMessages.length,
          dropped,
          compacted: compactedSummaries.length > 0,
          compactedSummaries: compactedSummaries.length,
        });
        return resultMessages;
      }

      // Drop the oldest message(s) and try to compact them
      const droppedMessages: ChatMessage[] = [];
      // Drop in pairs (user+assistant or tool+assistant) to keep coherence
      if (history.length >= 2) {
        droppedMessages.push(history.shift()!);
        droppedMessages.push(history.shift()!);
      } else {
        droppedMessages.push(history.shift()!);
      }

      // Try to compact the dropped messages
      const summary = await this.compactMessagesWithOllama(droppedMessages, baseUrl, model, abort);
      if (summary) {
        compactedSummaries.push(summary);
      }
    }

    // Even with only system + current user it's too long — keep just those two.
    this.log(`[context] history cleared; only system + current user kept`);
    this.debugLog('context_trim', { maxTokens, totalTokens, messageCount: messages.length, trimmedTo: 2, dropped: messages.length - 2, compacted: false });
    return [system, currentUser];
  }

  buildHandler(): vscode.ChatRequestHandler {
    return async (request, context, response, token) => {
      if (request.command === 'selectModel') {
        await vscode.commands.executeCommand('manulai.selectModel');
        const config = vscode.workspace.getConfiguration('manulai');
        const model = String(config.get('ollamaModel', ''));
        response.markdown(model ? `Active model: \`${model}\`` : 'No model selected.');
        return;
      }
      if (request.command === 'model') {
        const config = vscode.workspace.getConfiguration('manulai');
        const model = String(config.get('ollamaModel', ''));
        const autoApprove = this.getAutoApprove();
        const agentMode = this.getAgentMode();
        const lines = [
          model ? `Active model: \`${model}\`` : 'No model selected. Run `@manulai /selectModel`.',
          `Agent mode: \`${agentMode}\``,
          `Auto-approve: ${autoApprove ? 'on' : 'off'}`,
        ];
        response.markdown(lines.join('\n'));
        return;
      }
      if (request.command === 'toggleAutoApprove') {
        const current = this.getAutoApprove();
        const next = !current;
        await this.setAutoApprove(next);
        response.markdown(`Auto-approve is now **${next ? 'ON' : 'OFF'}**.`);
        return;
      }
      if (request.command === 'setAgentMode') {
        const arg = request.prompt?.trim().toLowerCase() || '';
        const validModes = ['chat', 'agent', 'planner'];
        const mode = validModes.includes(arg) ? arg : 'agent';
        await this.setAgentMode(mode);
        response.markdown(`Agent mode is now **${mode}**.`);
        return;
      }
      if (request.command === 'instructions') {
        const instructions = await readAgentInstructions();
        if (instructions) {
          const preview = instructions.content.length > 500
            ? instructions.content.slice(0, 500) + '...'
            : instructions.content;
          response.markdown(`**Found instructions:** \`${instructions.source}\`\n\n\`\`\`markdown\n${preview}\n\`\`\``);
        } else {
          response.markdown('No agent instructions found. Expected files: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules` in the workspace root.');
        }
        return;
      }
      if (request.command === 'skills') {
        const skills = await readWorkspaceSkills();
        if (skills.length > 0) {
          const lines = skills.map(
            (s) => `- **${s.name}** — \`${s.source}\`${s.description ? `\n  ${s.description}` : ''}`
          );
          response.markdown(`**Found ${skills.length} skill(s):**\n\n${lines.join('\n')}`);
        } else {
          response.markdown('No workspace skills found. Expected directories: `.claude/skills/`, `skills/`, `.github/skills/`, `.ai/skills/` containing `SKILL.md` files.');
        }
        return;
      }

      const config = vscode.workspace.getConfiguration('manulai');
      const model = String(config.get('ollamaModel', '')).trim();
      const baseUrl = String(config.get('ollamaBaseUrl', 'http://localhost:11434')).replace(/\/$/, '');
      const systemPrompt = String(config.get('systemPrompt', 'You are ManulAI, a privacy local coding assistant running inside VS Code. Work across any programming language. Prefer precise, minimal changes and explain results clearly.')).trim();
      const agentMode = this.getAgentMode();
      const debugMode = Boolean(config.get('debugMode', false));
      if (debugMode !== this.debugMode) {
        this.debugMode = debugMode;
        if (this.debugMode) {
          this.initDebugLog();
        }
      }

      if (!model) {
        response.markdown('No Ollama model selected. Run **ManulAI: Select Ollama Model** or set `manulai.ollamaModel`.');
        return;
      }

      const messages: ChatMessage[] = [];
      let effectiveSystemPrompt = systemPrompt;

      // Inject workspace agent instructions if available
      const instructions = await readAgentInstructions();
      if (instructions) {
        effectiveSystemPrompt += '\n\n' + formatInstructionsForPrompt(instructions);
        this.log(`[instructions] loaded from ${instructions.source}`);
      }

      // Inject workspace skills if available
      const skills = await readWorkspaceSkills();
      if (skills.length > 0) {
        effectiveSystemPrompt += '\n\n' + formatSkillsForPrompt(skills);
        this.log(`[skills] loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(', ')}`);
      }

      const isAgentLike = agentMode === 'agent' || agentMode === 'planner';

      if (agentMode === 'agent') {
        effectiveSystemPrompt += '\n\nYou are in Agent mode. You may read files, edit code, and run terminal commands using the tools below.';
        effectiveSystemPrompt += '\n\nCRITICAL RULES:';
        effectiveSystemPrompt += '\n1. Execute ONLY what the user explicitly asked. Do NOT do extra work.';
        effectiveSystemPrompt += '\n2. STOP immediately after completing the task. Do NOT read files to "verify" or "check" your work.';
        effectiveSystemPrompt += '\n3. Do NOT scan the project or list files after creating/editing files unless the user asked.';
        effectiveSystemPrompt += '\n4. If the user asked to create a file — create it and STOP. Do not read it back.';
        effectiveSystemPrompt += '\n5. If the user asked to edit a file — edit it and STOP. Do not read it back.';
        effectiveSystemPrompt += '\n6. After outputting a tool JSON, STOP. Do not write any additional text.';
        effectiveSystemPrompt += '\n\n' + getAgentToolInstructions();
      } else if (agentMode === 'planner') {
        effectiveSystemPrompt += '\n\nYou are in Planner mode. Prefer concise, step-by-step responses. Use tools for small deliberate actions.';
        effectiveSystemPrompt += '\n\nCRITICAL RULES:';
        effectiveSystemPrompt += '\n1. Execute ONLY what the user explicitly asked. Do NOT do extra work.';
        effectiveSystemPrompt += '\n2. STOP immediately after completing the task. Do NOT read files to "verify" or "check" your work.';
        effectiveSystemPrompt += '\n3. Do NOT scan the project or list files after creating/editing files unless the user asked.';
        effectiveSystemPrompt += '\n4. After outputting a tool JSON, STOP. Do not write any additional text.';
        effectiveSystemPrompt += '\n\n' + getAgentToolInstructions();
      } else {
        effectiveSystemPrompt += '\n\nYou are in Chat mode. Answer questions and review code without suggesting file changes or tool calls.';
      }
      if (effectiveSystemPrompt) {
        messages.push({ role: 'system', content: effectiveSystemPrompt });
      }

      for (const turn of context.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          if (turn.participant === 'manulai.manulai') {
            const content = (turn.prompt || '').trim();
            if (content) messages.push({ role: 'user', content });
          }
        } else if (turn instanceof vscode.ChatResponseTurn) {
          if (turn.participant === 'manulai.manulai') {
            let text = '';
            for (const part of turn.response) {
              if (part instanceof vscode.ChatResponseMarkdownPart) {
                text += part.value.value;
              }
            }
            if (text.trim()) messages.push({ role: 'assistant', content: text });
          }
        }
      }

      const userPrompt = (request.prompt || '').trim();
      if (userPrompt) {
        messages.push({ role: 'user', content: userPrompt });
      } else {
        response.markdown('Please enter a message.');
        return;
      }

      this.debugLog('user_request', {
        prompt: userPrompt,
        model,
        agentMode,
        autoApprove: this.getAutoApprove(),
        messageCount: messages.length,
      });

      // Verify the model exists before attempting to use it
      const modelAvailable = await this.verifyModelAvailable(baseUrl, model);
      if (!modelAvailable) {
        response.markdown(
          `**Model not found:** \`${model}\` is not available in your local Ollama.\n\n` +
          `To fix this:\n` +
          `1. Pull the model: \`ollama pull ${model}\`\n` +
          `2. Or select a different model with \`@manulai /selectModel\`\n\n` +
          `Available models: run \`ollama list\` to see what's installed.`
        );
        return;
      }

      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());

      try {
        await this.runAgentLoop(baseUrl, model, messages, response, abort, isAgentLike);
      } catch (err: any) {
        this.log(`[ManulAiChatParticipant] error: ${err?.message || String(err)}`);
        this.debugLog('agent_error', { error: err?.message || String(err), stack: err?.stack || null });
        response.markdown(`\n\n**Error:** ${err?.message || String(err)}`);
      }
    };
  }

  /**
   * Runs the agent loop: stream response → check for tool calls → execute → repeat.
   */
  private async runAgentLoop(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    response: vscode.ChatResponseStream,
    abort: AbortController,
    isAgentLike: boolean
  ): Promise<void> {
    const MAX_TURNS = 15;
    const MAX_SAME_TOOL_REPEAT = 3;
    let turnCount = 0;
    const recentToolSignatures: string[] = [];

    while (turnCount < MAX_TURNS) {
      if (abort.signal.aborted) {
        this.log('[agent] loop aborted');
        return;
      }

      turnCount++;
      this.log(`[agent] turn ${turnCount}/${MAX_TURNS}`);

      // Show progress indicator while the model is "thinking"
      response.progress(isAgentLike ? 'Thinking…' : 'Typing…');

      const trimmedMessages = await this.truncateMessagesToFit(messages, model, baseUrl, abort);
      const assistantText = await this.streamAndCollect(baseUrl, model, trimmedMessages, response, abort);

      if (!assistantText) {
        return;
      }

      // In chat mode, just stream and stop — no tool execution.
      if (!isAgentLike) {
        return;
      }

      // Check for text-based tool calls
      const toolCalls = extractToolCallsFromText(assistantText);
      this.debugLog('ollama_response', {
        turn: turnCount,
        contentLength: assistantText.length,
        hasToolCalls: toolCalls.length > 0,
        contentPreview: assistantText.substring(0, 300),
      });
      const cleanText = stripToolCallsFromText(assistantText);

      if (toolCalls.length === 0) {
        // No tools — assistant gave a final answer.
        return;
      }

      this.debugLog('tool_calls_detected', {
        turn: turnCount,
        count: toolCalls.length,
        tools: toolCalls.map((tc) => tc.function.name),
      });

      // Add assistant message (with stripped tools) to history
      messages.push({ role: 'assistant', content: cleanText || '(tool call)' });

      // Approval check — agent mode defaults to auto-execute
      let autoApprove = this.getAutoApprove();
      const toolNames = toolCalls.map((tc) => tc.function.name).join(', ');

      if (!autoApprove) {
        // Show interactive approval buttons in chat
        response.markdown(`\n\n---\n\n**⏸️ Tool approval required:** \`${toolNames}\`\n\n`);
        response.button({
          command: 'manulai.approveTool',
          title: '✅ Approve',
        });
        response.button({
          command: 'manulai.declineTool',
          title: '❌ Decline',
        });
        response.markdown(`\n\nClick **Approve** to execute this tool, or **Decline** to skip.\nYou can also run \`/toggleAutoApprove\` to always execute tools without asking.`);
        return;
      }

      // Execute tools
      response.markdown(`\n\n---\n\n`);

      let lastToolWasWrite = false;
      let lastToolWasTerminal = false;

      for (const toolCall of toolCalls) {
        if (abort.signal.aborted) {
          return;
        }

        const name = toolCall.function.name;
        const args = toolCall.function.arguments;
        this.log(`[agent] executing tool: ${name}`);

        // Detect repeated tool call loops
        const signature = `${name}:${JSON.stringify(args)}`;
        const repeatCount = recentToolSignatures.filter(s => s === signature).length;
        if (repeatCount >= MAX_SAME_TOOL_REPEAT) {
          const errorMsg = `Tool loop detected: ${name} has been called ${repeatCount} times with the same arguments. Stopping to prevent infinite loop.`;
          this.log(`[agent] ${errorMsg}`);
          this.debugLog('tool_loop_detected', { turn: turnCount, tool: name, repeatCount, signature });
          response.markdown(`\n⚠️ **${errorMsg}**\n`);
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: errorMsg }),
            tool_name: name,
          });
          response.markdown(`\n\n**⚠️ Agent stopped:** detected an infinite loop.`);
          return;
        }
        recentToolSignatures.push(signature);
        if (recentToolSignatures.length > 10) {
          recentToolSignatures.shift();
        }

        // Show which tool is running
        response.progress(`Executing ${name}…`);

        this.debugLog('tool_exec_start', {
          turn: turnCount,
          tool: name,
          args: this.redactArgsForLog(args),
        });

        const result = await executeTool(name, args);

        this.debugLog('tool_exec_result', {
          turn: turnCount,
          tool: name,
          error: result.error || null,
          result: result.content ? result.content.substring(0, 500) : null,
        });

        const toolContent = result.error
          ? JSON.stringify({ error: result.error })
          : result.content;

        messages.push({
          role: 'tool',
          content: toolContent,
          tool_name: name,
        });

        // Track if this was a write or terminal operation
        if ((name === 'create_or_edit_file' || name === 'replace_in_file') && !result.error) {
          lastToolWasWrite = true;
        }
        if (name === 'execute_terminal_command' && !result.error) {
          lastToolWasTerminal = true;
        }

        // Stream brief result to user — human-friendly formatting
        if (result.error) {
          response.markdown(`\n❌ **Error** — \`${name}\`\n\n${result.error}\n`);
        } else {
          switch (name) {
            case 'create_or_edit_file': {
              const filePath = String(args.filename ?? args.filepath ?? 'unknown');
              const content = String(args.content ?? '');
              response.markdown(`\n📝 **Created** \`${filePath}\`\n\n\`\`\`${this.detectLanguage(filePath)}\n${content}\n\`\`\`\n`);
              break;
            }
            case 'replace_in_file': {
              const filePath = String(args.filepath ?? 'unknown');
              const oldText = String(args.old_text ?? args.oldText ?? '');
              const newText = String(args.new_text ?? args.newText ?? '');
              response.markdown(`\n✏️ **Modified** \`${filePath}\`\n\n\`\`\`diff\n- ${oldText.replace(/\n/g, '\n- ')}\n+ ${newText.replace(/\n/g, '\n+ ')}\n\`\`\`\n`);
              break;
            }
            case 'read_specific_file':
            case 'read_file_slice': {
              const filePath = String(args.filepath ?? args.path ?? 'unknown');
              response.markdown(`\n📖 **Read** \`${filePath}\`\n`);
              break;
            }
            case 'execute_terminal_command': {
              const cmd = String(args.command ?? args.cmd ?? '');
              response.markdown(`\n💻 **Ran** \`\`${cmd}\`\`\n`);
              break;
            }
            case 'delete_file': {
              const filePath = String(args.filepath ?? args.path ?? 'unknown');
              response.markdown(`\n🗑️ **Deleted** \`${filePath}\`\n`);
              break;
            }
            default:
              response.markdown(`\n✅ \`${name}\` completed\n`);
          }
        }

        // If a file was created, add a reference so the user can click it
        if (name === 'create_or_edit_file' && !result.error) {
          try {
            const parsed = JSON.parse(result.content);
            const filePath = parsed.path || args.filename || args.filepath;
            if (filePath) {
              const uri = vscode.Uri.file(filePath.startsWith('/') ? filePath : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', filePath));
              response.reference(uri);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      // If the last tool was a successful write, stop the loop
      if (lastToolWasWrite) {
        this.log('[agent] last tool was a write operation — stopping loop');
        this.debugLog('agent_stop', { turn: turnCount, reason: 'write_operation' });
        return;
      }
      // If ANY terminal command was executed successfully, stop the loop
      // Terminal commands are usually the final step in a workflow
      if (lastToolWasTerminal) {
        this.log('[agent] terminal command executed — stopping loop');
        this.debugLog('agent_stop', { turn: turnCount, reason: 'terminal_command' });
        return;
      }

      response.markdown(`\n\n---\n\n`);
    }

    // Max turns reached
    this.debugLog('agent_stop', { turn: turnCount, reason: 'max_turns', maxTurns: MAX_TURNS });
    response.markdown(`\n\n**⚠️ Agent stopped:** maximum turn limit (${MAX_TURNS}) reached.`);
  }

  /**
   * Streams Ollama response to the chat UI while collecting the full text.
   * Returns the collected assistant text (excluding reasoning).
   */
  private async streamAndCollect(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    response: vscode.ChatResponseStream,
    abort: AbortController
  ): Promise<string> {
    let reasoningOpen = false;
    let answerStarted = false;
    let collectedText = '';

    await this.streamOllamaChat(baseUrl, model, messages, {
      onChunk: (chunk) => {
        if (abort.signal.aborted) return;
        // Stream reasoning in real-time as a blockquote
        if (chunk.reasoning) {
          if (!reasoningOpen) {
            response.markdown('> ');
            reasoningOpen = true;
          }
          response.markdown(chunk.reasoning.replace(/\n/g, '\n> '));
        }
        // Stream content in real-time (for debugging / transparency)
        if (chunk.content) {
          if (reasoningOpen && !answerStarted) {
            response.markdown('\n\n');
            reasoningOpen = false;
          }
          answerStarted = true;
          collectedText += chunk.content;
          response.markdown(chunk.content);
        }
        if (chunk.error) {
          response.markdown(`\n\n**Error:** ${chunk.error}`);
        }
      },
      onError: (err) => {
        response.markdown(`\n\n**Error:** ${err.message}`);
      },
      onDone: () => {},
    }, abort);

    return collectedText;
  }

  /**
   * Checks whether the requested model is installed locally via Ollama /api/tags.
   */
  private async verifyModelAvailable(baseUrl: string, model: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { return false; }
      const data = await res.json() as { models?: Array<{ name?: string }> };
      const names = (data.models ?? []).map((m) => m.name ?? '');
      return names.includes(model) || names.some((n) => n.startsWith(model + ':'));
    } catch {
      return false;
    }
  }

  /**
   * Fetches from Ollama with retry for model-loading transient failures.
   * Retries on HTTP 503/500 that mention "model is loading" or "model failed to load".
   */
  private async fetchWithModelRetry(
    url: string,
    body: Record<string, unknown>,
    abortController: AbortController,
    model: string,
    maxRetries = 3
  ): Promise<Response> {
    const isModelLoadingError = (status: number, text: string): boolean => {
      if (status !== 500 && status !== 503) { return false; }
      const lower = text.toLowerCase();
      return lower.includes('model failed to load') ||
             lower.includes('model is loading') ||
             lower.includes('loading model') ||
             lower.includes('resource limitations');
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (abortController.signal.aborted) {
        throw new Error('Request aborted');
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (response.ok || !isModelLoadingError(response.status, await response.clone().text())) {
        return response;
      }

      const text = await response.text();
      this.log(`[ollama] model loading error on attempt ${attempt + 1}/${maxRetries + 1}: HTTP ${response.status}`);
      this.debugLog('ollama_model_loading_retry', {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        status: response.status,
        error: text.slice(0, 200),
        model,
      });

      if (attempt < maxRetries) {
        const delay = 3000 + attempt * 2000; // 3s, 5s, 7s
        this.log(`[ollama] waiting ${delay}ms before retry…`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // All retries exhausted — throw a user-friendly error
        throw new Error(
          `Ollama could not load model "${model}" after ${maxRetries + 1} attempts.\n\n` +
          `This usually means:\n` +
          `• The model is too large for your available RAM/VRAM\n` +
          `• Ollama is still downloading or unpacking the model\n` +
          `• Another process is using the GPU\n\n` +
          `Try:\n` +
          `1. Run \`ollama ps\` to check loaded models\n` +
          `2. Run \`ollama pull ${model}\` to verify the model is available\n` +
          `3. Try a smaller model (e.g. \`phi4-mini:3.8b\` or \`llama3.1:8b\`)\n` +
          `4. Check Ollama server logs: \`ollama logs\` or \`journalctl -u ollama\``
        );
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('Unexpected end of retry loop');
  }

  private async streamOllamaChat(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    callbacks: {
      onChunk: (chunk: OllamaStreamChunk) => void;
      onError: (err: Error) => void;
      onDone: () => void;
    },
    abortController: AbortController
  ): Promise<void> {
    const url = `${baseUrl}/api/chat`;
    const body = {
      model,
      messages,
      stream: true,
    };

    this.log(`[ManulAiChatParticipant] streaming to ${url}, model=${model}`);
    this.debugLog('ollama_request', {
      model,
      messageCount: messages.length,
      url,
    });

    const response = await this.fetchWithModelRetry(url, body, abortController, model);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    if (!response.body) {
      throw new Error('Ollama response has no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        if (abortController.signal.aborted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const parsed = this.parser.parse(chunk);
        for (const p of parsed) {
          callbacks.onChunk(p);
          if (p.done) {
            callbacks.onDone();
            return;
          }
          if (p.error) {
            callbacks.onError(new Error(p.error));
            return;
          }
        }
      }
      callbacks.onDone();
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Non-streaming Ollama call for conversation compaction.
   */
  private async callOllamaNonStream(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    abortController: AbortController
  ): Promise<string> {
    const url = `${baseUrl}/api/chat`;
    const body = {
      model,
      messages,
      stream: false,
    };

    const response = await this.fetchWithModelRetry(url, body, abortController, model);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}

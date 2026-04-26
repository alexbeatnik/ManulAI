import * as vscode from 'vscode';
import * as path from 'path';
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

  /**
   * Truncates message history to fit within the model's context window.
   * Always preserves the system prompt (index 0) and the latest user message (last index).
   * Drops oldest history pairs first.
   */
  private truncateMessagesToFit(
    messages: ChatMessage[],
    model: string
  ): ChatMessage[] {
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
      return messages;
    }

    // Keep system (0) and last message (current user); drop from the front of history.
    const system = messages[0];
    const currentUser = messages[messages.length - 1];
    let history = messages.slice(1, -1);

    while (history.length > 0) {
      const trimmed = [system, ...history, currentUser];
      const tokens = trimmed.reduce(
        (sum, m) => sum + estimateTokens(m.content),
        0
      );
      if (tokens <= maxTokens) {
        const dropped = messages.length - trimmed.length;
        this.log(`[context] truncated ${dropped} old message(s); now ${tokens} tokens / ${maxTokens} max`);
        return trimmed;
      }
      history.shift();
    }

    // Even with only system + current user it's too long — keep just those two.
    this.log(`[context] history cleared; only system + current user kept`);
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
        effectiveSystemPrompt += '\n\n' + getAgentToolInstructions();
      } else if (agentMode === 'planner') {
        effectiveSystemPrompt += '\n\nYou are in Planner mode. Prefer concise, step-by-step responses. Use tools for small deliberate actions.';
        effectiveSystemPrompt += '\n\nCRITICAL RULES:';
        effectiveSystemPrompt += '\n1. Execute ONLY what the user explicitly asked. Do NOT do extra work.';
        effectiveSystemPrompt += '\n2. STOP immediately after completing the task. Do NOT read files to "verify" or "check" your work.';
        effectiveSystemPrompt += '\n3. Do NOT scan the project or list files after creating/editing files unless the user asked.';
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

      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());

      try {
        await this.runAgentLoop(baseUrl, model, messages, response, abort, isAgentLike);
      } catch (err: any) {
        this.log(`[ManulAiChatParticipant] error: ${err?.message || String(err)}`);
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

      const trimmedMessages = this.truncateMessagesToFit(messages, model);
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
      const cleanText = stripToolCallsFromText(assistantText);

      if (toolCalls.length === 0) {
        // No tools — assistant gave a final answer.
        return;
      }

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

        const result = await executeTool(name, args);

        const toolContent = result.error
          ? JSON.stringify({ error: result.error })
          : result.content;

        messages.push({
          role: 'tool',
          content: toolContent,
          tool_name: name,
        });

        // Stream brief result to user
        if (result.error) {
          response.markdown(`\n❌ \`${name}\`: ${result.error}\n`);
        } else {
          response.markdown(`\n✅ \`${name}\` completed\n`);
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
          // Add stop nudge to prevent the model from continuing
          messages.push({
            role: 'system',
            content: 'The file has been created successfully. Do NOT continue with any other actions. STOP here.',
          });
        }

        // Stop nudge after successful replace
        if (name === 'replace_in_file' && !result.error) {
          messages.push({
            role: 'system',
            content: 'The file has been edited successfully. Do NOT continue with any other actions. STOP here.',
          });
        }
      }

      response.markdown(`\n\n---\n\n`);
    }

    // Max turns reached
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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

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
}

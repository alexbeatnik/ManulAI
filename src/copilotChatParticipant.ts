import * as vscode from 'vscode';
import { OllamaStreamParser } from './ollamaStreamParser';
import type { OllamaStreamChunk } from './ollamaStreamParser';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
    return this.globalState?.get<boolean>(ManulAiChatParticipant.AUTO_APPROVE_KEY) ?? false;
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
      if (agentMode === 'agent') {
        effectiveSystemPrompt += '\n\nYou are in Agent mode. You may suggest file edits, terminal commands, and browser automation steps, but you cannot execute them directly in this chat panel. For full tool execution, use the ManulAI Secondary Sidebar chat.';
      } else if (agentMode === 'planner') {
        effectiveSystemPrompt += '\n\nYou are in Planner mode. Prefer concise, step-by-step responses. You may suggest small actions but cannot execute tools in this chat panel.';
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

      let reasoningOpen = false;
      let answerStarted = false;

      try {
        await this.streamOllamaChat(baseUrl, model, messages, {
          onChunk: (chunk) => {
            if (abort.signal.aborted) return;
            if (chunk.reasoning) {
              if (!reasoningOpen) {
                response.markdown('> _Thinking…_\n>\n> ');
                reasoningOpen = true;
              }
              response.markdown(chunk.reasoning.replace(/\n/g, '\n> '));
            }
            if (chunk.content) {
              if (reasoningOpen && !answerStarted) {
                response.markdown('\n\n');
                reasoningOpen = false;
              }
              answerStarted = true;
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
      } catch (err: any) {
        this.log(`[ManulAiChatParticipant] error: ${err?.message || String(err)}`);
        response.markdown(`\n\n**Error:** ${err?.message || String(err)}`);
      }
    };
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

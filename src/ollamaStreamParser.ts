export interface OllamaStreamChunk {
  reasoning?: string;
  content?: string;
  done?: boolean;
  error?: string;
}

/**
 * Parses Ollama /api/chat NDJSON stream and extracts:
 * - content from message.content
 * - reasoning from <think>...</think> tags inside content
 *
 * Maintains internal state so it can be fed raw strings incrementally.
 */
export class OllamaStreamParser {
  private buffer = '';
  private isThinking = false;

  /**
   * Feed a raw chunk string (may contain partial NDJSON lines).
   * Returns an array of parsed stream chunks.
   */
  parse(raw: string): OllamaStreamChunk[] {
    this.buffer += raw;
    const chunks: OllamaStreamChunk[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.substring(0, newlineIndex).trim();
      this.buffer = this.buffer.substring(newlineIndex + 1);

      if (!line) continue;

      const parsed = this.parseLine(line);
      if (parsed) {
        chunks.push(parsed);
      }
    }

    return chunks;
  }

  private parseLine(line: string): OllamaStreamChunk | null {
    if (line === '[DONE]') {
      this.isThinking = false;
      return { done: true };
    }

    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      return null;
    }

    if (json.error) {
      return { error: String(json.error) };
    }

    if (json.done) {
      this.isThinking = false;
      return { done: true };
    }

    const rawText = json.message?.content;
    if (typeof rawText === 'string') {
      return this.handleRawText(rawText);
    }

    return null;
  }

  private handleRawText(text: string): OllamaStreamChunk | null {
    // Stream reasoning AND content live — never buffer reasoning until </think>, otherwise
    // long thinking passages leave the user staring at a static "Thinking…" placeholder until
    // the model finally closes the tag (often 30+ s for thinking models like gemma4 / phi4).
    let output: OllamaStreamChunk | null = null;
    let i = 0;

    while (i < text.length) {
      if (!this.isThinking) {
        const startIdx = text.indexOf('<think>', i);
        if (startIdx === -1) {
          const slice = text.substring(i);
          if (slice.length > 0) {
            output = output || {};
            output.content = (output.content || '') + slice;
          }
          break;
        } else {
          const before = text.substring(i, startIdx);
          if (before.length > 0) {
            output = output || {};
            output.content = (output.content || '') + before;
          }
          this.isThinking = true;
          i = startIdx + '<think>'.length;
        }
      } else {
        const endIdx = text.indexOf('</think>', i);
        if (endIdx === -1) {
          // Emit the partial reasoning slice immediately instead of buffering until </think>.
          const slice = text.substring(i);
          if (slice.length > 0) {
            output = output || {};
            output.reasoning = (output.reasoning || '') + slice;
          }
          break;
        } else {
          const slice = text.substring(i, endIdx);
          if (slice.length > 0) {
            output = output || {};
            output.reasoning = (output.reasoning || '') + slice;
          }
          this.isThinking = false;
          i = endIdx + '</think>'.length;
        }
      }
    }

    return output;
  }
}

---
name: ollama-streaming
description: Guidelines for modifying Ollama streaming and reasoning extraction in src/ollamaStreamParser.ts. Covers NDJSON parsing, <think> tag extraction, and integration with the Copilot Chat participant.
---

# ollama-streaming

`OllamaStreamParser` parses Ollama `/api/chat` NDJSON streams and extracts both regular content and reasoning blocks from `<think>...</think>` tags.

## Scope

- `src/ollamaStreamParser.ts` — the parser.
- `src/copilotChatParticipant.ts` — participant usage.

## Rules

1. **NDJSON format.** Ollama streams newline-delimited JSON objects, not SSE. Each line is a separate JSON object. The parser splits on `\n`, not `\n\n`.
2. **Stateful parsing.** The parser maintains internal state (`buffer`, `isThinking`, `thinkBuffer`) so it can handle partial lines across multiple `parse()` calls.
3. **<think> tag extraction.** Reasoning is extracted from `<think>...</think>` tags inside `message.content`. The parser tracks whether it is inside a think block and emits `reasoning` separately from `content`.
4. **Partial think blocks.** If `</think>` has not arrived yet, accumulate text in `thinkBuffer` and wait for the next chunk. Do not emit partial reasoning until the block closes.
5. **done flag.** When `json.done === true` or line is `[DONE]`, flush any remaining think buffer and emit `{ done: true }`.
6. **error handling.** If `json.error` is present, emit `{ error: string }` immediately.
7. **No assumptions about field names.** Ollama's response shape may vary. Always access `json.message?.content` as the primary text source.

## Interface

```ts
export interface OllamaStreamChunk {
  reasoning?: string;
  content?: string;
  done?: boolean;
  error?: string;
}
```

## Common mistakes

- Treating Ollama stream as SSE (splitting on `\n\n` instead of `\n`).
- Emitting partial `<think>` content as `content` before the closing tag arrives.
- Not handling the case where `<think>` and `</think>` appear in the same chunk.
- Forgetting to flush `thinkBuffer` on stream end, losing the final reasoning block.

## Testing

Test the parser by feeding it known NDJSON strings:

```ts
const parser = new OllamaStreamParser();
const chunks = parser.parse('{"message":{"content":"<think>Let"}}\n{"message":{"content":" me think</think>Hello"}}\n');
// Expect: [{reasoning:"Let me think"}, {content:"Hello"}]
```

Add unit tests in a new `src/ollamaStreamParser.test.ts` if modifying parsing logic.

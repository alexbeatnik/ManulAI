/**
 * Known Ollama model context-window sizes (in tokens).
 * Keys are model name prefixes; first match wins.
 *
 * Sources: ollama.com/library model pages.
 * When unsure, default to 128K.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Gemma 4 — 256K context
  'gemma4': 256_000,

  // Llama 3.1 / 3.2 / 3.3 — 128K
  'llama3.1': 128_000,
  'llama3.2': 128_000,
  'llama3.3': 128_000,

  // Qwen3 / Qwen2.5 — 128K
  'qwen3': 128_000,
  'qwen2.5': 128_000,
  'qwen2': 32_000,

  // DeepSeek — 128K
  'deepseek': 128_000,

  // Mistral / Mixtral — 32K (older) or 128K (newer)
  'mistral': 32_000,
  'mixtral': 32_000,
  'mistral-large': 128_000,

  // Phi 4 — 128K
  'phi4': 128_000,
  'phi3': 128_000,

  // CodeLlama — 16K (base), 100K (extended variants)
  'codellama': 16_000,

  // Gemma 2 / Gemma (original) — 8K
  'gemma2': 8_000,
  'gemma:': 8_000,

  // Stable Code — 16K
  'stable-code': 16_000,

  // Nous Hermes / Yi — 128K
  'nous-hermes': 128_000,
  'yi': 128_000,

  // Dolphin — 128K
  'dolphin': 128_000,

  // Orca — 128K
  'orca': 128_000,

  // StarCoder2 — 16K
  'starcoder2': 16_000,
  'starcoder': 8_000,
};

/** Default context window when model is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Safety margin — keep only this fraction of the context window for the prompt. */
export const CONTEXT_WINDOW_USAGE_RATIO = 0.75;

/**
 * Rough heuristic: 1 token ≈ 4 characters for English/Unicode text.
 * This is intentionally conservative (over-counts) to avoid overflow.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Look up the context-window size for a given Ollama model name.
 */
export function getContextWindow(model: string): number {
  const lower = model.toLowerCase().trim();
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return size;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Calculate the maximum tokens available for the chat prompt,
 * accounting for the safety margin.
 */
export function getMaxPromptTokens(model: string): number {
  return Math.floor(getContextWindow(model) * CONTEXT_WINDOW_USAGE_RATIO);
}

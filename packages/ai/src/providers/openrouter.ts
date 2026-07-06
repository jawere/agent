// @jawere/ai — OpenRouter provider
// OpenRouter provides a unified API for many models.
// Supports image generation models via the images endpoint.

import type {
  Model,
  Provider,
  ApiKeyAuth,
} from "../types.ts";
import { openAICompatibleProvider } from "./openai-compatible.ts";
import { KeyResolver } from "../api-keys.ts";

export function openRouterProvider(
  apiKey?: string,
  keyResolver?: KeyResolver,
): Provider<"openai-completions" | "openrouter"> {
  return openAICompatibleProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: [
      {
        id: "openai/gpt-4o",
        name: "GPT-4o (OpenRouter)",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text", "image"],
        cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
        supportsImages: true,
      },
      {
        id: "anthropic/claude-sonnet-4-20250514",
        name: "Claude Sonnet 4 (OpenRouter)",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        contextWindow: 200000,
        maxTokens: 8192,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
        supportsImages: true,
      },
      {
        id: "google/gemini-2.5-pro",
        name: "Gemini 2.5 Pro (OpenRouter)",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
        supportsImages: true,
      },
    ],
  }, keyResolver);
}

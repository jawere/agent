// @jawere/ai — Mistral provider (La Plateforme API)
// Mistral has an OpenAI-compatible API with some differences.

import type {
  Model,
  Provider,
  ApiKeyAuth,
} from "../types.ts";
import { openAICompatibleProvider, type OpenAICompatibleProviderConfig } from "./openai-compatible.ts";
import { KeyResolver } from "../api-keys.ts";

export function mistralProvider(
  apiKey?: string,
  keyResolver?: KeyResolver,
): Provider<"openai-completions" | "mistral-conversations"> {
  return openAICompatibleProvider({
    id: "mistral",
    name: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    models: [
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        api: "openai-completions",
        provider: "mistral",
        baseUrl: "https://api.mistral.ai/v1",
        reasoning: false,
        contextWindow: 131072,
        maxTokens: 8192,
        input: ["text", "image"],
        cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
        supportsImages: true,
      },
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        api: "openai-completions",
        provider: "mistral",
        baseUrl: "https://api.mistral.ai/v1",
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 4096,
        input: ["text"],
        cost: { input: 0.2, output: 0.6, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "codestral-latest",
        name: "Codestral",
        api: "openai-completions",
        provider: "mistral",
        baseUrl: "https://api.mistral.ai/v1",
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 8192,
        input: ["text"],
        cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  }, keyResolver);
}

// @jawere/ai — DeepSeek provider (OpenAI-compatible API)

import type {
  Provider,
  ApiKeyAuth,
  Model,
} from "../types.ts";
import { openAICompletionsStream } from "./openai.ts";
import OpenAI from "openai";

export function deepseekProvider(
  apiKey?: string,
  baseURL?: string,
): Provider<"openai-completions"> {
  const resolveApiKey = (): string | undefined => {
    if (apiKey) return apiKey;
    return process.env.DEEPSEEK_API_KEY;
  };

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: resolveApiKey,
    source: "$DEEPSEEK_API_KEY",
  };

  const effectiveBaseUrl = baseURL ?? "https://api.deepseek.com/v1";
  const client = new OpenAI({
    apiKey: resolveApiKey() ?? "missing",
    baseURL: effectiveBaseUrl,
  });

  return {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: effectiveBaseUrl,
    auth,

    getModels(): Model<"openai-completions">[] {
      return [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat V3",
          api: "openai-completions",
          provider: "deepseek",
          baseUrl: effectiveBaseUrl,
          reasoning: false,
          contextWindow: 131072,
          maxTokens: 8192,
          input: ["text"],
          cost: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.10 },
        },
        {
          id: "deepseek-reasoner",
          name: "DeepSeek Reasoner R1",
          api: "openai-completions",
          provider: "deepseek",
          baseUrl: effectiveBaseUrl,
          reasoning: true,
          contextWindow: 131072,
          maxTokens: 32768,
          input: ["text"],
          cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.20 },
        },
      ];
    },

    stream(model, context, options) {
      return openAICompletionsStream(client, model, context, options);
    },
  };
}

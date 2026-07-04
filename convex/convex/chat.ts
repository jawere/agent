import { v } from "convex/values";
import { httpAction } from "./_generated/server";

/**
 * Streaming chat endpoint — proxies to DeepSeek and returns SSE.
 */
export const chatStream = httpAction(async (ctx, request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "DEEPSEEK_API_KEY not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  let body: {
    model?: string;
    messages: any[];
    tools?: any[];
    systemPrompt: string;
    stream?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = body.stream !== false;

  const deepseekBody = {
    model: body.model || "deepseek-chat",
    messages: [
      { role: "system", content: body.systemPrompt },
      ...body.messages,
    ],
    max_tokens: 32768,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    thinking: { type: "enabled" },
    reasoning_effort: "high",

    ...(body.tools?.length ? { tools: body.tools } : {}),
  };

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(deepseekBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return new Response(JSON.stringify({ error: `DeepSeek API error ${response.status}: ${errorText}` }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
});

/**
 * Non-streaming chat endpoint.
 */
export const chatSync = httpAction(async (ctx, request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "DEEPSEEK_API_KEY not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  let body: {
    model?: string;
    messages: any[];
    tools?: any[];
    systemPrompt: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const deepseekBody = {
    model: body.model || "deepseek-chat",
    messages: [
      { role: "system", content: body.systemPrompt },
      ...body.messages,
    ],
    max_tokens: 32768,
    stream: false,
  };

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(deepseekBody),
  });

  const data = await response.json();
  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
});

# @jawere/coding-agent

Terminal AI coding agent — reads your codebase, edits files, writes new files, and executes shell commands autonomously.

## Install

```bash
npm install -g @jawere/coding-agent
```

Requires **Node.js 22+**.

## Setup

```bash
jawere --setup
```

Or set environment variables:

```bash
export AI_API_KEY=sk-...
export AI_PROVIDER=openai
export AI_MODEL=gpt-4o
```

## Usage

```bash
jawere                  # start interactive REPL
jawere "fix the bug"    # run a one-shot task
```

## Providers

Supports OpenAI, Anthropic, Google Gemini, AWS Bedrock, and any OpenAI-compatible endpoint.

```bash
export AI_PROVIDER=anthropic
export AI_MODEL=claude-sonnet-4-20250514
```

## From Source

```bash
git clone https://github.com/jawere/agent.git
cd agent
npm install
npm start
```

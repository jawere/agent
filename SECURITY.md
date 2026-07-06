# Security

jawere is a terminal AI coding agent. It intentionally performs operations that security
scanners flag as risky. This document explains why each capability exists and what
protections are in place.

## Legitimate Capabilities

### Shell Access
The `bash` tool lets the AI agent run shell commands in your working directory.
This is the core feature of a coding agent — it builds, tests, and modifies code on
your behalf. Commands are confined to the working directory and dangerous patterns
(sudo, rm -rf /, curl-pipe-shell, force push to main) are blocked.

### Filesystem Access
The agent reads, writes, and edits files within your project. Path traversal is
blocked — all file operations are confined to the working directory. No files
outside the working directory can be accessed.

### Network Access
The agent calls AI provider APIs (OpenAI, Anthropic, Google Gemini, etc.) over
HTTPS. It also makes web search and documentation lookup requests. No data is
sent anywhere except to the AI provider you configure.

### Environment Variable Access
API keys and configuration are read from environment variables (e.g.,
OPENAI_API_KEY). This is the standard way to provide credentials without
hardcoding secrets.

## What jawere Does NOT Do

- Does not send your code or data to any server other than the AI provider you choose
- Does not install anything without asking
- Does not run outside the working directory you specify
- Does not persist API keys (they stay in your environment)
- Does not contain obfuscated, minified, or malicious code

## Reporting a Vulnerability

If you find a security issue, please open an issue on the repository.

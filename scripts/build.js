import * as esbuild from "esbuild";
import { copyFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgDir = resolve(root, "packages/coding-agent");
const outDir = resolve(pkgDir, "dist");

const externals = [
  "openai",
  "@anthropic-ai/sdk",
  "@aws-sdk/client-bedrock-runtime",
  "@aws-sdk/credential-providers",
  "@aws-sdk/signature-v4",
  "@aws-crypto/sha256-js",
  "@google/generative-ai",
];

// Mark ALL Node built-ins as external so esbuild doesn't try to bundle/polyfill them
const nodeBuiltins = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
];

// CLI binary
await esbuild.build({
  entryPoints: [resolve(root, "packages/coding-agent/src/cli.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(outDir, "cli.js"),
  external: [...externals, ...nodeBuiltins],
  sourcemap: false,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
});

// Public API
await esbuild.build({
  entryPoints: [resolve(root, "packages/coding-agent/src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(outDir, "index.js"),
  external: [...externals, ...nodeBuiltins],
  sourcemap: false,
  minify: false,
});

// Copy README and LICENSE into dist so they're included in the npm package
await mkdir(outDir, { recursive: true });
await copyFile(resolve(root, "README.md"), resolve(outDir, "README.md"));
await copyFile(resolve(root, "LICENSE"), resolve(outDir, "LICENSE"));

console.log("Build complete → packages/coding-agent/dist/");

import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "packages/coding-agent/dist");

const externals = [
  "openai",
  "@anthropic-ai/sdk",
  "@aws-sdk/client-bedrock-runtime",
  "@aws-sdk/credential-providers",
  "@aws-sdk/signature-v4",
  "@aws-crypto/sha256-js",
  "@google/generative-ai",
];

// CLI binary
await esbuild.build({
  entryPoints: [resolve(root, "packages/coding-agent/src/cli.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(outDir, "cli.js"),
  external: externals,
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
  external: externals,
  sourcemap: false,
  minify: false,
});

console.log("Build complete → packages/coding-agent/dist/");

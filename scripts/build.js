import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Build the CLI bundle from the coding-agent package
await esbuild.build({
  entryPoints: [resolve(root, "packages/coding-agent/src/cli.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(root, "dist/index.js"),
  external: [
    "tsx",
    "esbuild",
    "@jawere/ai",
    "@jawere/agent",
    "@jawere/tui",
    "@jawere/coding-agent",
    "@jawere/orchestrator",
  ],
  sourcemap: false,
  minify: false,
});

console.log("Build complete. Run 'node dist/index.js' to start.");

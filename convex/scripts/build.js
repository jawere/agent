// ============================================================================
// Build script — bundle with esbuild for global npm install
// ============================================================================

import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.js",
  external: [
    // Native Node modules
    "node:*",
    // Convex keeps its own bundle structure
    "convex",
  ],
  banner: {
    js: `import { createRequire as __cjsCreateRequire } from 'node:module'; const require = __cjsCreateRequire(import.meta.url);`,
  },
});

console.log("Built dist/index.js");

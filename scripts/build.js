import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Build the CLI bundle
await esbuild.build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(root, 'dist/index.js'),
  external: ['tsx', 'esbuild'], // never bundle these
  sourcemap: false,
  minify: false,
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});

console.log('Build complete.');

#!/usr/bin/env node
import('../dist/index.js').catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env node
import("../packages/coding-agent/dist/cli.js").catch((err) => {
  console.error("Failed to start jawere:", err);
  process.exit(1);
});

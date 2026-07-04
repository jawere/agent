#!/usr/bin/env node
// ============================================================================
// ponytail — AI coding agent (global CLI entry point)
// Uses production Convex by default.
// ============================================================================

// Ensure production Convex URL unless explicitly overridden
if (!process.env.CONVEX_URL) {
  process.env.CONVEX_URL = "https://friendly-pigeon-624.convex.cloud";
}

import("../dist/index.js").catch((err) => {
  console.error("Failed to start ponytail:", err.message);
  process.exit(1);
});

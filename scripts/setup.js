#!/usr/bin/env node
// @jawere — Installation and setup script
// Usage: node scripts/setup.js  or  npm run setup
// Checks prerequisites, installs dependencies, builds, launches interactive config.

import { execSync } from "child_process";
import { spawn } from "child_process";

const G_GREEN  = "\x1b[38;2;184;187;38m";
const G_GREEN2 = "\x1b[38;2;142;192;124m";
const G_GRAY   = "\x1b[38;2;146;131;116m";
const G_DIM    = "\x1b[38;2;102;92;84m";
const G_FG     = "\x1b[38;2;235;219;178m";
const R = "\x1b[0m";

const step = (label) => console.log(`\n${G_GRAY}── ${label} ──${R}`);
const ok = (msg) => console.log(`  ${G_GREEN}✓${R} ${msg}`);
const warn = (msg) => console.log(`  ${G_GREEN2}!${R} ${msg}`);
const fail = (msg) => {
  console.log(`  ${G_GREEN2}✗${R} ${msg}`);
  process.exit(1);
};

console.log("");
console.log(`${G_GREEN}╔══════════════════════════════════════════════════╗${R}`);
console.log(`${G_GREEN}║     jawere — AI Coding Agent Installer           ║${R}`);
console.log(`${G_GREEN}╚══════════════════════════════════════════════════╝${R}`);

// ── 1. Prerequisites ─────────────────────────────────────────────

step("Checking prerequisites");

const nodeVersion = process.versions.node;
const [major] = nodeVersion.split(".").map(Number);
if (major < 22) {
  fail(`Node.js ${nodeVersion} found — v22+ required. Install: https://nodejs.org/`);
}
ok(`Node.js ${nodeVersion}`);

try {
  const npmVersion = execSync("npm --version", { encoding: "utf-8" }).trim();
  ok(`npm ${npmVersion}`);
} catch {
  fail("npm not found");
}

try {
  execSync("git --version", { encoding: "utf-8", stdio: "pipe" });
  ok("git");
} catch {
  warn("git not found (optional, needed for diff tool)");
}

// ── 2. Install dependencies ──────────────────────────────────────

step("Installing dependencies");
try {
  execSync("npm install", { encoding: "utf-8", stdio: "inherit" });
  ok("Dependencies installed");
} catch {
  fail("npm install failed — run manually: npm install");
}

// ── 3. Build packages ───────────────────────────────────────────

step("Building packages");
try {
  execSync("npm run build", { encoding: "utf-8", stdio: "inherit" });
  ok("Build complete");
} catch {
  warn("Build had issues — dev mode (tsx) will still work");
}

// ── 4. Launch interactive config ─────────────────────────────────

step("API key configuration");

// Launch the CLI's built-in --setup wizard
const child = spawn(
  process.argv[0],
  ["--import", "tsx", "packages/coding-agent/src/cli.ts", "--setup"],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  console.log("");
  if (code === 0) {
    console.log(`${G_GREEN}╔══════════════════════════════════════════════════╗${R}`);
    console.log(`${G_GREEN}║     Setup Complete!                              ║${R}`);
    console.log(`${G_GREEN}╚══════════════════════════════════════════════════╝${R}`);
    console.log("");
    console.log(`  ${G_DIM}Start the agent:${R}`);
    console.log(`    ${G_FG}npm start${R}`);
    console.log("");
    console.log(`  ${G_DIM}Config files:${R}`);
    console.log(`    ~/.jawere/key.enc     — AES-256-GCM encrypted API key`);
    console.log(`    ~/.jawere/config.json — provider and model settings`);
    console.log("");
  }
  process.exit(code ?? 0);
});

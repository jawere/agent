// @jawere/coding-agent — Pi binary resolver
// Finds the user's globally installed Pi and verifies RPC mode support.

import { execSync, spawn } from "child_process";

export interface PiInfo {
  path: string;
  version: string;
  rpcSupported: boolean;
}

/**
 * Resolve the Pi binary from the user's PATH.
 * Also probes version and verifies RPC mode works.
 */
export async function resolvePiBinary(): Promise<PiInfo | null> {
  let piPath: string | null = null;

  // Resolve from PATH
  try {
    piPath = execSync("which pi 2>/dev/null || where pi 2>/dev/null", {
      encoding: "utf-8",
      shell: "/bin/bash",
    }).trim();
  } catch {}

  if (!piPath) {
    try {
      // Also check common local install paths
      const localPath = execSync(
        "which npx 2>/dev/null && npx --yes @earendil-works/pi-coding-agent --version 2>/dev/null",
        { encoding: "utf-8", shell: "/bin/bash", timeout: 10000 }
      ).trim();
      // npx resolved it, but we want the actual binary — fall through
    } catch {}
    return null;
  }

  // Get version
  let version = "unknown";
  try {
    version = execSync(`"${piPath}" --version 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {}

  // Verify RPC mode works
  let rpcSupported = false;
  try {
    const child = spawn(piPath, ["--mode", "rpc", "--no-session"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });

    const probeResult = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("timeout"));
      }, 4000);

      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          child.kill();
          resolve(stdout);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("exit", () => {
        clearTimeout(timer);
        if (stdout.trim()) resolve(stdout);
        else reject(new Error("no output"));
      });

      child.stdin?.write('{"type":"get_state","id":"_probe"}\n');
    });

    // If we got valid JSON with a response, RPC works
    const parsed = JSON.parse(probeResult.split("\n")[0]);
    rpcSupported = parsed?.type === "response" && parsed?.success === true;
  } catch {
    rpcSupported = false;
  }

  return { path: piPath, version, rpcSupported };
}

/**
 * Get install instructions based on the platform.
 */
export function getPiInstallInstructions(): string {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    return [
      "Pi not found. Install it with one of:",
      "  npm install -g @earendil-works/pi-coding-agent",
      "  or download from https://github.com/earendil-works/pi/releases",
    ].join("\n");
  }

  return [
    "Pi not found. Install it with:",
    "  npm install -g @earendil-works/pi-coding-agent",
    "  or: curl -fsSL https://pi.anthropic.com/install.sh | bash",
  ].join("\n");
}

// @jawere/tui — @-tag file autocomplete for the prompt box

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Colors
const G_GREEN  = "\x1b[38;2;184;187;38m";
const G_GREEN2 = "\x1b[38;2;142;192;124m";
const G_DIM    = "\x1b[38;2;102;92;84m";
const G_FG     = "\x1b[38;2;235;219;178m";
const G_BLUE   = "\x1b[38;2;131;165;152m";
const R = "\x1b[0m";

const MAX_MATCHES = 20;

// ── Types ─────────────────────────────────────────────────────────

export interface TagState {
  /** Whether we're currently in @ mode (user typed @ and is typing a query) */
  active: boolean;
  /** The column where @ was typed (in the current line) */
  atCol: number;
  /** The row where @ was typed */
  atRow: number;
  /** The query string after @ */
  query: string;
  /** All available files */
  files: string[];
  /** Current filtered matches */
  matches: string[];
  /** Currently highlighted match index (-1 = none) */
  selectedIndex: number;
  /** How many lines the dropdown occupies (for cleanup) */
  dropdownLines: number;
}

export function createTagState(files: string[]): TagState {
  return {
    active: false,
    atCol: 0,
    atRow: 0,
    query: "",
    files,
    matches: [],
    selectedIndex: -1,
    dropdownLines: 0,
  };
}

// ── File list helpers ─────────────────────────────────────────────

/**
 * Load file list from .codebase/tree-shallow.yaml if available,
 * otherwise do a quick glob of common source directories.
 */
export function loadFileList(workDir: string): string[] {
  const treePath = resolve(workDir, ".codebase", "tree-shallow.yaml");
  if (existsSync(treePath)) {
    try {
      const content = readFileSync(treePath, "utf-8");
      return parseFilesFromTreeYaml(content);
    } catch {
      // fall through
    }
  }
  return [];
}

/**
 * Parse file paths from tree.yaml format.
 * Looks for lines like: `    - filename.ext:`
 */
function parseFilesFromTreeYaml(yaml: string): string[] {
  const files: string[] = [];
  let currentDir = "";

  for (const line of yaml.split("\n")) {
    // Directory header: `  somedir/:`
    const dirMatch = line.match(/^  ([\w\-./]+):$/);
    if (dirMatch && !line.startsWith("    ")) {
      currentDir = dirMatch[1] === "root" ? "" : dirMatch[1];
      continue;
    }

    // File entry: `    - filename.ext:`
    const fileMatch = line.match(/^    - ([^:]+):$/);
    if (fileMatch) {
      const name = fileMatch[1];
      const fullPath = currentDir ? `${currentDir}${name}` : name;
      files.push(fullPath);
    }
  }

  return files.sort();
}

// ── Matching ──────────────────────────────────────────────────────

/**
 * Filter files by query using fuzzy matching.
 * Matches if every character in query appears in order in the filename.
 * Prioritizes:
 * 1. Exact prefix match on filename (no directory)
 * 2. Exact prefix match on full path
 * 3. Contains match
 * 4. Fuzzy match
 */
export function matchFiles(query: string, files: string[]): string[] {
  if (!query) return files.slice(0, MAX_MATCHES);

  const q = query.toLowerCase();
  const scored: { file: string; score: number }[] = [];

  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.split("/").pop() || lower;

    let score = 0;

    // Exact prefix on basename
    if (base.startsWith(q)) {
      score = 1000 + (base.length - q.length);
    }
    // Exact prefix on full path
    else if (lower.startsWith(q)) {
      score = 900;
    }
    // Contains
    else if (lower.includes(q)) {
      score = 500 - lower.indexOf(q);
    }
    // Fuzzy: all chars in order
    else {
      let qi = 0;
      let lastIdx = -1;
      let gaps = 0;
      for (let i = 0; i < lower.length && qi < q.length; i++) {
        if (lower[i] === q[qi]) {
          if (lastIdx >= 0) gaps += i - lastIdx - 1;
          lastIdx = i;
          qi++;
        }
      }
      if (qi === q.length) {
        score = 100 - gaps;
      } else {
        continue; // no match
      }
    }

    scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_MATCHES).map((s) => s.file);
}

// ── Rendering ─────────────────────────────────────────────────────

/**
 * Render the dropdown below the prompt.
 * Returns the ANSI string to write.
 */
export function renderDropdown(
  matches: string[],
  selectedIndex: number,
  columns: number,
): string {
  if (matches.length === 0) return "";

  const maxWidth = Math.min(columns - 4, 80);
  let out = "";

  // Top border
  out += `\r\n${G_DIM}${"\u2500".repeat(Math.min(maxWidth, 40))}${R}`;

  const show = matches.slice(0, Math.min(matches.length, 15));

  for (let i = 0; i < show.length; i++) {
    const file = show[i];
    const isSelected = i === selectedIndex;
    const displayName = truncatePath(file, maxWidth - 4);

    if (isSelected) {
      out += `\r\n  ${G_GREEN}\u203a ${G_BLUE}${displayName}${R}`;
    } else {
      out += `\r\n  ${G_DIM}  ${G_FG}${displayName}${R}`;
    }
  }

  if (matches.length > show.length) {
    out += `\r\n  ${G_DIM}\u2026 and ${matches.length - show.length} more${R}`;
  }

  return out;
}

function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;

  // Keep the filename, truncate directory
  const parts = path.split("/");
  if (parts.length === 1) return path.slice(0, maxLen - 3) + "\u2026";

  const filename = parts.pop()!;
  const dirBudget = maxLen - filename.length - 4; // "…/" + filename
  if (dirBudget <= 0) return "\u2026/" + filename.slice(-(maxLen - 4));

  // Build directory prefix
  let dirPrefix = "";
  for (let i = 0; i < parts.length; i++) {
    const candidate = dirPrefix ? `${dirPrefix}/${parts[i]}` : parts[i];
    if (candidate.length > dirBudget) {
      dirPrefix = (dirPrefix ? `\u2026${dirPrefix.slice(-dirBudget + 1)}` : `\u2026`);
      break;
    }
    dirPrefix = candidate;
  }

  return `${dirPrefix}/${filename}`;
}

// ── Completion ────────────────────────────────────────────────────

/**
 * Get the completed text to replace the @query segment.
 */
export function getCompletion(matches: string[], selectedIndex: number): string | null {
  if (matches.length === 0) return null;
  if (selectedIndex < 0 || selectedIndex >= matches.length) {
    // Auto-select first match if only one
    if (matches.length === 1) return matches[0];
    return null;
  }
  return matches[selectedIndex];
}

/**
 * Find the @ position in a line, scanning backwards from cursor.
 * Returns the column of @ and the query after it, or null.
 */
export function findAtQuery(line: string, col: number): { atCol: number; query: string } | null {
  // Scan backwards from col to find @ that isn't preceded by a word char
  for (let i = col - 1; i >= 0; i--) {
    if (line[i] === "@") {
      // Make sure it's not part of an email or something
      if (i === 0 || !isWordChar(line[i - 1])) {
        return { atCol: i, query: line.slice(i + 1, col) };
      }
    }
    if (line[i] === " " || line[i] === "\t") break;
  }
  return null;
}

function isWordChar(ch: string): boolean {
  return /[\w.\-@]/.test(ch);
}

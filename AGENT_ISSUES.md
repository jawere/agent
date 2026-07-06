# Agent Issues — Collected during test-writing session (2026-07-06)

Each issue is a concrete gap found while adding 122 tests across 5 packages.
Grouped by layer.

---

## Scanner / .codebase

### 1. Summaries lack behavioral detail
Current summaries say "Tool line formatting, assistant rendering" but don't capture return-type hints or edge-case behavior (e.g. `stripThinking` strips tags only, not content between tags; `formatToolStart` uses ANSI that inflates string length). Function-level behavioral notes would prevent wrong assumptions.

### 2. State doesn't persist across CLI restarts
State tracks reads within one session but resets on next `npm start`. A "project understanding" blob persisted across restarts would mean the agent doesn't re-read the entire codebase on every task.

### 3. No change-detection diff on startup
Scanner has checksums but doesn't surface "3 files changed since last scan" to the agent. The agent should know what's stale without manually checking.

### 4. No test-awareness in tree.yaml
Test files are classified as type "test" but the scanner doesn't extract test descriptions, covered functions, or test counts. When tests fail, there's no cached map of "this test covers that function."

---

## System Prompt

### 5. No test-writing guidance
Prompt says "be concise" but doesn't mention test conventions: `node:test`, `node:assert/strict`, test files live alongside source as `*.test.ts`, run with `--experimental-strip-types`. An agent asked to "add tests" has to discover the framework by grepping package.json scripts.

### 6. No "learn from failures" loop
After 3 wrong assertions on `stripThinking`, the agent kept guessing instead of re-reading the source. The prompt should instruct: "when a test assertion fails, re-read the actual source function to understand its behavior before fixing the test."

### 7. --experimental-strip-types awareness
Agent doesn't know Node 22+ can run `.ts` test files directly with `--experimental-strip-types`. Might suggest Jest or vitest instead.

---

## Missing Tools

### 8. Quick-eval / inline expression runner
No way to quickly evaluate `stripThinking("<think>x</think>y")` without spawning a full bash command writing a temp file. A tool like `eval` or `node -e` integrated into the tool set would collapse debug cycles.

### 9. Diff against last test run
No test-output caching. After fixing tests, can't diff against the previous run to see which assertions went from FAIL→PASS. Would make it obvious when fixes are working.

### 10. State-diff / staleness detection
`state.md` tracks what was read, but no tool says "you read `display.ts` 3 minutes ago — it was just edited, your memory is stale." After `edit` tool modifies a file, state entries for that file should be invalidated.

### 11. Bulk-read directory
Reading 20 files required 20 individual `read` calls. A `read --recursive` or `read-all src/` would collapse directory exploration into one call.

### 12. Isolated test runner
When `db.ts` tests kept failing due to shared mutable state, needed to re-run entire suite to check each fix. Running a single `describe` or `it` block in isolation would speed up the fix cycle.

---

## Workflow

### 13. Amend + retest is manual
Edit → commit → wait for all 122 tests → fail → fix → repeat. If the agent could amend then re-run just the affected `describe` block as one atomic action, it would collapse the cycle.

### 14. No "affected tests" hint after edits
After modifying `db.ts`, had to manually reason about which tests were impacted. A tool or output that says "you changed `persistMessages` — 5 tests in `db.test.ts` depend on it" would help.

### 15. Per-package incremental test runs in pre-commit
Pre-commit runs all 122 tests regardless of what changed. An `--only-changed` mode that runs only packages with git diffs would speed up the commit cycle (crypto scrypt alone adds ~800ms).

### 16. No `describe`/`it`-level test targeting
`npm test -w @jawere/ai` runs all 64 tests in the package. No way to filter to a single describe block or test name from the CLI. Node's `--test-name-pattern` exists but isn't exposed through the npm script.

---

## Provider / Config

### 17. Configurable thinking/reasoning level per task
The agent uses whatever the model default is. Some tasks (like test-writing, where precision matters) might benefit from higher reasoning budget. No way to say "think harder on this one."

### 18. No model-switching mid-session
Can't switch from a cheap model (code reading, grepping) to an expensive one (test generation) within the same session. Every turn uses the same model.

---

## Bugs Found During This Session

### 19. db.ts persistMessages dropped all messages when first was system prompt
`if (messages[0]?.role === 'system') return;` — fixed. The function also had an off-by-one in `startIdx = existingCount + 1` that caused message duplication on re-persist. Simplified to `startIdx = existingCount`.

### 20. CI swallowed test failures
`npm run test --if-present || echo "✓ build passed"` — fixed. Now fails the build on test failures.

## 2026-07-26T12:52:20Z
You are Worker Patch. Your working directory is `d:\Luceandombra\.agents\worker_patch`.
Your assignment is to patch `d:\Luceandombra\fittingMath.js` to fix two edge-case vulnerabilities identified during adversarial stress testing:

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Tasks:
1. **Fix Null Viewport Crash**:
   In `landmarkToWorld(lm, viewportOptions = {}, zOverride = undefined)`:
   - Add `const opts = viewportOptions || {};` at the start of the function.
   - Use `opts.width`, `opts.height`, `opts.videoWidth`, `opts.videoHeight` instead of accessing `viewportOptions` directly.
   - Ensures passing `null` as `viewportOptions` will not throw `TypeError`.

2. **Sanitize Filter Callbacks against NaN / Infinity**:
   In `calculateScaleAndPosition(...)`:
   - Check if `filteredScale` returned by `filterState.scaleFilter.filter` is finite (`Number.isFinite(...)`). If not, fallback to `rawScale`.
   - Check if `filteredX`, `filteredY`, `filteredZ` returned by position filters are finite. If not, fallback to `rawX`, `rawY`, `rawZ`.
   - Add unit tests in `tests/accuracy.test.js` covering `landmarkToWorld(lm, null)` and non-finite filter outputs.

3. **Verification**:
   - Run `npm test` using run_command to confirm all tests pass cleanly.

4. **Handoff**:
   - Record progress in `d:\Luceandombra\.agents\worker_patch\progress.md`.
   - Write handoff report to `d:\Luceandombra\.agents\worker_patch\handoff.md`.
   - Send completion message to orchestrator when finished.

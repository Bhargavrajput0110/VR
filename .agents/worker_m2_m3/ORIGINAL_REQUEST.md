## 2026-07-26T12:18:57Z
You are Worker M2 & M3. Your working directory is `d:\Luceandombra\.agents\worker_m2_m3`.
Your assignment is to implement Milestones 2 & 3 for the Luceandombra AR test suite.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Detailed Tasks:
1. **Extract Fitting Math Module (`fittingMath.js`)**:
   - Create `fittingMath.js` at project root (`d:\Luceandombra\fittingMath.js`) containing exported math functions:
     - `LM` constants object (`NOSE_REST: 6`, `L_TEMPLE: 234`, `R_TEMPLE: 454`, etc.)
     - `lmValid(lm)`
     - `safeLM(lmArray, idx)`
     - `landmarkToWorld(lm, viewportOptions, zOverride)` where `viewportOptions = { width, height, videoWidth, videoHeight }` (defaulting to window/video elements if in browser)
     - `calculateScaleAndPosition(lmArray, viewportOptions, filterState)` returning `{ scale: number, position: {x, y, z}, templeW: number, anchorWorld: {x, y, z} }`
     - `OneEuroFilter` class
   - Make `fittingMath.js` compatible with both Node.js (`export ...` or UMD/ESM dual exports) and browser import.
   - Refactor `d:\Luceandombra\app.js` to import/use `fittingMath.js` so that `app.js` browser behavior remains 100% intact and functional.

2. **Configure `package.json` for `npm test` (R1)**:
   - Edit `d:\Luceandombra\package.json` to add `"test": "node --test"` to `"scripts"`.

3. **Implement Accuracy Verification Unit & Integration Tests (R2)**:
   - Create `d:\Luceandombra\tests\accuracy.test.js` using Node.js built-in `node:test` and `node:assert/strict`.
   - Implement `createMockFaceLandmarks(overrides)` helper generating a 478-point landmark array `{x, y, z}`.
   - Assert R2 Requirement 1: 3D model scale matches `templeW * 1.15` (where `templeW` is the world distance between Landmark 234 left temple and Landmark 454 right temple).
   - Assert R2 Requirement 2: 3D model position origin matches Landmark 6 (`NOSE_REST`).
   - Assert `lmValid` boundary checks and `landmarkToWorld` horizontal mirroring transformation (`1.0 - lm.x`).

4. **Refactor E2E UI Test (`test.js`)**:
   - Update `d:\Luceandombra\test.js` to use `node:test` and `node:assert/strict`.
   - Programmatically start a static HTTP server on port 3000 in `before()` hook and close it in `after()` hook.
   - Run Puppeteer checks on `http://localhost:3000` verifying title, `#startScreen`, and `#startBtn` click transition.

5. **Build & Test Verification**:
   - Run `npm test` via terminal to verify all tests pass with exit code 0.
   - Log exact command and stdout/stderr output in your handoff report.

6. **Documentation & Handoff**:
   - Record progress and liveness in `d:\Luceandombra\.agents\worker_m2_m3\progress.md`.
   - Write full handoff report to `d:\Luceandombra\.agents\worker_m2_m3\handoff.md`.
   - Send completion message to orchestrator when finished.

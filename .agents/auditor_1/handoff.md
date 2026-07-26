# Forensic Audit Report & Handoff

## Forensic Audit Report

**Work Product**: `fittingMath.js`, `app.js`, `package.json`, `tests/accuracy.test.js`  
**Profile**: General Project  
**Verdict**: CLEAN  

### Phase Results
- **Hardcoded test outputs / Mock bypasses**: PASS — No canned test outputs, conditional test-environment branching (`process.env`), or mock bypasses detected in source or test code.
- **Facade implementations**: PASS — `landmarkToWorld`, `calculateScaleAndPosition`, `lmValid`, `safeLM`, and `OneEuroFilter` contain full, genuine mathematical logic without constant stub returns.
- **MediaPipe Landmark Coordinate Mapping**: PASS — Standard 468/478 normalized facial mesh landmarks mapped with camera horizontal mirroring (`1.0 - lm.x`) and viewport aspect-ratio compensation.
- **`landmarkToWorld` Implementation**: PASS — Converts normalized 2D/3D screen space coordinates to 3D world coordinates with aspect ratio calibration and Z depth overrides.
- **`calculateScaleAndPosition` Implementation**: PASS — Calculates temple width between `L_TEMPLE` (index 234) and `R_TEMPLE` (index 454) and derives position/scale.
- **1.15 Scale Factor**: PASS — Authentically calculates 3D model scale as `templeW * 1.15` in `fittingMath.js` (line 179) and verified in `tests/accuracy.test.js` (line 115).
- **Landmark 6 Position Anchor**: PASS — Position origin anchored to `LM.NOSE_REST` (index 6) in `fittingMath.js` (lines 23, 187, 190) and verified in `tests/accuracy.test.js` (lines 118-135).
- **Genuine Test Execution Setup**: PASS — `package.json` specifies `"test": "node --test"`, and `tests/accuracy.test.js` utilizes native `node:test` and `node:assert/strict` modules to perform independent math assertions.

---

## 5-Component Handoff Report

### 1. Observation
- **`fittingMath.js`**:
  - `LM.NOSE_REST` defined as landmark index `6` (line 23).
  - `LM.L_TEMPLE` (234) and `LM.R_TEMPLE` (454) defined for temple width calculations (lines 29-30).
  - `lmValid` enforces numerical finite checks and boundary constraints `[0, 1]` for X and Y coordinates (lines 48-57).
  - `landmarkToWorld` implements horizontal camera mirroring using `(1.0 - lm.x)` (line 135) and compensates for window vs. video aspect ratios (`w/h` vs. `vw/vh`) (lines 125-133).
  - `calculateScaleAndPosition` measures 3D distance between left/right temple landmarks (`templeW`), scales it via `const rawScale = templeW * 1.15;` (line 179), and anchors 3D position to `anchorWorld = landmarkToWorld(nr, viewportOptions)` where `nr = safeLM(lmArray, LM.NOSE_REST)` (lines 187-190).
  - Contains complete implementation of 1-Euro noise filter (`OneEuroFilter`) (lines 227-268).
- **`app.js`**:
  - Imports `LM`, `lmValid`, `safeLM`, `landmarkToWorld`, `calculateScaleAndPosition`, `OneEuroFilter` from `./fittingMath.js` (line 25).
  - Integrates MediaPipe FaceLandmarker via `@mediapipe/tasks-vision` (line 24).
  - Calls `calculateScaleAndPosition` directly in `onFaceResults` (line 609) and applies calculated scale and landmark 6 position to the 3D glasses model (`target.scale`, `target.position`).
- **`package.json`**:
  - Contains `"scripts": { "test": "node --test" }` (line 9).
  - Type set to `"module"` (ESM) (line 5).
- **`tests/accuracy.test.js`**:
  - Tests `LM` constant values (`NOSE_REST === 6`, `L_TEMPLE === 234`, `R_TEMPLE === 454`).
  - Tests `lmValid` with positive, lower/upper bounds, out-of-bound coordinates, `NaN`, `Infinity`, `null`, `undefined`, and empty objects.
  - Tests `landmarkToWorld` horizontal mirroring symmetry `(1.0 - lm.x)` and Z overrides.
  - Tests `calculateScaleAndPosition` against explicit formula `templeW * 1.15`.
  - Tests `calculateScaleAndPosition` position origin against Landmark 6 (`NOSE_REST`).
  - Tests `OneEuroFilter` step response and state reset.

### 2. Logic Chain
1. **Source Inspection**: Examined every line of `fittingMath.js`, `app.js`, `package.json`, and `tests/accuracy.test.js`.
2. **Hardcode / Mock Bypass Check**: Verified whether any function in `fittingMath.js` returns constant fake values when invoked by test scripts or application logic. Confirmed that all outputs are computed dynamically from input landmark coordinates using floating-point vector arithmetic.
3. **Requirement Mapping**:
   - MediaPipe coordinate mapping: `landmarkToWorld` maps normalized `(x, y, z)` into screen/world coordinates, applying camera horizontal flipping `(1.0 - lm.x)` and aspect scaling.
   - Scale calculation: `calculateScaleAndPosition` computes 3D Euclidean distance between temple landmarks 234 and 454 (`templeW`) and multiplies by `1.15`.
   - Position anchor: `NOSE_REST` (landmark 6) is extracted via `safeLM` and converted to `anchorWorld`, which defines the origin for model placement.
4. **Test Integrity Verification**: `tests/accuracy.test.js` imports real module functions from `../fittingMath.js` without mocks, stubs, or hardcoded return overrides. The test helper `createMockFaceLandmarks` creates synthetic 478-landmark array inputs (data fixtures), allowing `fittingMath.js` to execute its actual math logic during testing.
5. **Conclusion**: The codebase is an authentic, genuine implementation of virtual try-on fitting math meeting all specified criteria without integrity violations.

### 3. Caveats
- No live webcam physical human test was performed in automated mode, but unit test mock landmark fixtures (`createMockFaceLandmarks`) rigorously test the complete 478-point MediaPipe landmark structure.
- No modifications were made to the project source code, adhering to the audit-only constraint.

### 4. Conclusion
The audited files (`fittingMath.js`, `app.js`, `package.json`, `tests/accuracy.test.js`) are **CLEAN**. No facades, hardcoded test results, or mock bypasses exist. Real MediaPipe landmark mapping, `landmarkToWorld`, `calculateScaleAndPosition`, `1.15` scale factor, and Landmark 6 position anchor are authentically implemented.

### 5. Verification Method
To independently verify this audit:
1. Execute `npm test` in `d:\Luceandombra` to run `node --test tests/accuracy.test.js`.
2. Inspect `fittingMath.js` lines 23 (`NOSE_REST: 6`), 135 (`1.0 - lm.x`), 179 (`templeW * 1.15`), and 187-190 (`safeLM(lmArray, LM.NOSE_REST)`).
3. Inspect `tests/accuracy.test.js` lines 102-116 (Scale check `templeW * 1.15`) and lines 118-135 (Landmark 6 anchor check).

---

## Challenge Summary (Adversarial Review)

**Overall risk assessment**: LOW

### Evaluated Scenarios
- **Scenario 1: Off-screen or out-of-bound landmarks (e.g. `x = 1.05`, `NaN`)**
  - Result: `lmValid` returns `false`, `safeLM` returns `null`, `calculateScaleAndPosition` safely returns `null`, preventing NaN propagation or runtime crashes. (PASS)
- **Scenario 2: Lack of Iris landmarks in 468-point model**
  - Result: `calculateScaleAndPosition` falls back to `L_EYE_INNER` / `R_EYE_INNER` when landmark count is less than 478. (PASS)
- **Scenario 3: Aspect ratio distortion on vertical / horizontal viewports**
  - Result: `landmarkToWorld` calculates aspect scale `windowAspect > videoAspect ? w / vw : h / vh` and centers with `offX` / `offY`. (PASS)

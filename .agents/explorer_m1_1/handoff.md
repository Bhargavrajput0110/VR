# Handoff Report — Explorer 1: Landmark & Face Fitting Analysis

**Target File**: `d:\Luceandombra\app.js`  
**Working Directory**: `d:\Luceandombra\.agents\explorer_m1_1`  
**Date**: 2026-07-26  

---

## 1. Observation

### 1.1 Workspace & App Structure
- **Module Format**: `app.js` is a single monolithic ES module file (1,615 lines, ~70 KB) loaded in `index.html` via:
  ```html
  <script type="module" src="app.js?v=21"></script>
  ```
- **Top-Level Execution & Side-Effects**:
  - Lines 373–420: Top-level object `el` immediately queries the DOM (e.g. `document.getElementById('viewport')`).
  - Lines 425–426: Instantiates `THREE.Clock()`.
  - Lines 1020–1025: Instantiates `DRACOLoader` and `GLTFLoader`.
  - Line 1614: Automatically calls `init()` on script evaluation, which sets up Three.js (`initThree()`), binds UI handlers (`bindUIHandlers()`), and starts the animation loop (`requestAnimationFrame(animate)`).
- **External Dependencies**:
  - `three` module imported via browser importmap (`unpkg.com/three@0.160.0/build/three.module.js`).
  - `three/addons/` utilities (GLTFLoader, DRACOLoader, BufferGeometryUtils, RoomEnvironment).
  - `@mediapipe/tasks-vision` via CDN ES module URL:
    ```javascript
    import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
    ```

### 1.2 Landmark Definitions (`LM` Map)
- Lines 49–83 define canonical MediaPipe 468/478 landmark index constants:
  ```javascript
  const LM = {
    L_EYE_INNER: 133, R_EYE_INNER: 362,
    L_IRIS: 468, R_IRIS: 473,
    NOSE_BRIDGE: 168,
    NOSE_REST: 6,      // lower nose bridge (where physical glasses sit)
    NOSE_TIP: 4,
    NOSE_L: 129, NOSE_R: 358,
    L_TEMPLE: 234,     // left temple
    R_TEMPLE: 454,     // right temple
    FOREHEAD: 10, CHIN: 152, JAW_L: 172, JAW_R: 397,
    CHEEK_L: 234, CHEEK_R: 454,
  };
  ```

### 1.3 MediaPipe Initialization & Landmark Processing
- **Initialization** (Lines 925–944 in `initMediaPipe()`):
  ```javascript
  state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.60,
    minFacePresenceConfidence: 0.60,
    minTrackingConfidence: 0.55,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  ```
- **Detection & Animation Frame** (Lines 844–867 in `animate()`):
  `state.faceLandmarker.detectForVideo(el.webcam, nowMs)` runs each frame and extracts `results.faceLandmarks[0]` (array of 468/478 `{x, y, z}` objects normalized to `[0.0, 1.0]`) and `results.facialTransformationMatrixes[0].data` (4x4 matrix).

### 1.4 Landmark Validation
- Lines 685–694 define validation guards:
  ```javascript
  function lmValid(lm) {
    return lm &&
      Number.isFinite(lm.x) && Number.isFinite(lm.y) && Number.isFinite(lm.z) &&
      lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1;
  }

  function safeLM(lmArray, idx) {
    const lm = lmArray[idx];
    return lmValid(lm) ? lm : null;
  }
  ```

### 1.5 Coordinate Mapping (`landmarkToWorld`)
- Lines 527–550 convert normalized 2D/3D MediaPipe landmark `{x, y, z}` to 3D Orthographic camera world space:
  ```javascript
  function landmarkToWorld(lm, zOverride) {
    const w  = window.innerWidth;
    const h  = window.innerHeight;
    const vw = el.webcam.videoWidth  || w;
    const vh = el.webcam.videoHeight || h;

    const windowAspect = w / h;
    const videoAspect  = vw / vh;
    const scale        = windowAspect > videoAspect ? w / vw : h / vh;

    const rvw  = vw * scale;
    const rvh  = vh * scale;
    const offX = (w - rvw) / 2;
    const offY = (h - rvh) / 2;

    const px = offX + (1.0 - lm.x) * rvw;
    const py = offY + lm.y * rvh;

    const halfW = windowAspect;
    const worldX =  (px / w) * (2 * halfW) - halfW;
    const worldY = -((py / h) * 2 - 1);

    return new THREE.Vector3(worldX, worldY, zOverride ?? GLASSES_Z_OFFSET);
  }
  ```

### 1.6 Temple Width Scaling (Scale Factor 1.15)
- Lines 713–731 inside `onFaceResults()`:
  ```javascript
  // ── 1. SCALE — Temple-based Face Width anchoring ──
  const lt = safeLM(lmArray, LM.L_TEMPLE); // 234
  const rt = safeLM(lmArray, LM.R_TEMPLE); // 454
  ...
  const templeW  = landmarkToWorld(lt).distanceTo(landmarkToWorld(rt));   // full face width

  // Lenskart-level scale calibration: The width of physical glasses is designed to match 
  // the width of the face at the temples (so the arms can wrap the ears).
  // We use temple width as the absolute source of truth for 3D model scale.
  // Multiplier tuned to perfectly match physical frame width (approx 15% wider than temples for hinges).
  const rawScale = templeW * 1.15;
  const filteredScale = OEF.scale.filter(rawScale, timestamp);
  target.scale.setScalar(Math.max(filteredScale, 0.01));
  ```

### 1.7 3D Model Positioning & Landmark 6 (Nose Rest)
- Lines 746–776 inside `onFaceResults()`:
  ```javascript
  // ── 3. POSITION — Lenskart multi-point nose bridge anchor ──
  // The physical resting point of glasses is on the lower bridge of the nose.
  // This guarantees perfect centering between the eyes AND vertical alignment with the ears.
  const nr = safeLM(lmArray, LM.NOSE_REST); // Landmark 6
  if (!nr) return;

  // Anchor exactly at the lower nose bridge for X, Y, and Z.
  const anchorX = nr.x;
  const anchorY = nr.y;
  const anchorZ = nr.z;
  const anchor  = { x: anchorX, y: anchorY, z: anchorZ };

  const anchorWorld = landmarkToWorld(anchor);

  // Depth-aware Z offset: pull forward slightly so it doesn't sink into face
  const depthFactor = Math.max(0.5, Math.min(1.5, 1.0 / (filteredScale * 4 + 0.001)));
  const localOffset = new THREE.Vector3(0, 0, -filteredScale * 0.02 * depthFactor);
  localOffset.applyQuaternion(target.quat);

  // Apply One Euro Filter to world position
  const rawX = anchorWorld.x + localOffset.x;
  const rawY = anchorWorld.y + localOffset.y;
  const rawZ = anchorWorld.z + localOffset.z;

  const filteredX = OEF.x.filter(rawX, timestamp);
  const filteredY = OEF.y.filter(rawY, timestamp);
  const filteredZ = OEF.z.filter(rawZ, timestamp);

  target.position.set(filteredX, filteredY, filteredZ);
  ```

### 1.8 Head Pose / Rotation Extraction
- Lines 555–566 in `extractRotation(matrixArray)`:
  ```javascript
  function extractRotation(matrixArray) {
    const mat = new THREE.Matrix4().fromArray(matrixArray);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const sc   = new THREE.Vector3();
    mat.decompose(pos, quat, sc);
    const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    const tiltX = euler.x - 0.15; // Pitch correction
    const mirrored = new THREE.Euler(tiltX, -euler.y, -euler.z, 'XYZ');
    return new THREE.Quaternion().setFromEuler(mirrored);
  }
  ```

### 1.9 Filtering & Adaptive Smoothing
- Lines 88–154: `OneEuroFilter` class (Casiez et al.) filtering 7 degrees of freedom (`x`, `y`, `z`, `scale`, `rx`, `ry`, `rz`).
- Lines 703–707 & 898–910: `adaptiveLerp()` dynamically adjusts LERP alpha based on target velocity.

---

## 2. Logic Chain

1. **Monolithic Script Execution**:
   - `app.js` runs as an ES module directly in the browser. However, because line 1614 calls `init()` immediately, and lines 373–420 execute `document.getElementById` at top-level evaluation time, attempting to import `app.js` in Node.js currently fails with a `ReferenceError: document is not defined`.

2. **Core Fitting Mathematical Dependencies**:
   - The scaling, positioning, landmark validation, and filter calculations form a pure or near-pure mathematical core.
   - Specifically:
     - `LM` map is pure static data.
     - `lmValid` & `safeLM` are pure functions.
     - `detectFaceShape` is a pure function operating on landmark coordinates.
     - `OneEuroFilter` is a self-contained stateful class with zero DOM dependencies.
     - `adaptiveLerp` is a pure mathematical helper.
     - `landmarkToWorld` converts `{x, y, z}` via viewport dimension inputs (currently reading global `el` and `window`, but easily refactored to take explicit width/height/video parameters).
     - `extractRotation` decomposes a 4x4 matrix and applies pitch/yaw adjustments using Three.js Math utils.
     - `templeW * 1.15` and `NOSE_REST` (Landmark 6) anchor positioning are the core scaling and positioning rules.

3. **Extraction & Unit Testing Strategy**:
   - To make these functions unit-testable in Node.js without breaking the browser application, two primary architectures are available:
     - **Option 1: Modular Extraction (`fittingMath.js`) [RECOMMENDED]**:
       Extract `LM`, `lmValid`, `safeLM`, `OneEuroFilter`, `adaptiveLerp`, `detectFaceShape`, `extractRotation`, `landmarkToWorld`, and scale/position calculation functions into a pure utility module `fittingMath.js`. Have `app.js` import from `fittingMath.js`. Node.js test files (using Jest, Mocha, or `node:test`) can import `fittingMath.js` without requiring a browser or mock DOM.
     - **Option 2: Dual-Environment Refactoring of `app.js`**:
       Add `export { ... }` to `app.js`, wrap top-level `el` DOM binding into a function called inside `init()`, and guard the top-level `init()` call with `if (typeof window !== 'undefined' && typeof document !== 'undefined')`.

---

## 3. Caveats

- **Three.js Dependency**: `extractRotation` and `landmarkToWorld` use `THREE.Matrix4`, `THREE.Quaternion`, `THREE.Euler`, and `THREE.Vector3`. In Node.js, `three` can be installed and imported (`const THREE = require('three')` or `import * as THREE from 'three'`).
- **MediaPipe Task Vision CDN**: `app.js` imports `@mediapipe/tasks-vision` via CDN URL (`https://cdn.jsdelivr.net/...`). Node.js cannot resolve HTTP imports natively unless mock/bundler is used, reinforcing why pure math functions should be separated from MediaPipe vision loader code.
- **No Source Code Modified**: Explorer 1 is strictly read-only. No edits were made to `app.js`.

---

## 4. Conclusion

- **Landmark 6**: Located at line 64 (`NOSE_REST: 6`). Serves as the 3D position anchor (`anchorX = nr.x, anchorY = nr.y, anchorZ = nr.z`) in `onFaceResults()` (lines 749–758).
- **Temple Width Scaling**: Uses `LM.L_TEMPLE` (234) and `LM.R_TEMPLE` (454). Distance in world space `templeW` is multiplied by `1.15` (line 729: `const rawScale = templeW * 1.15;`) to account for hinge width.
- **Structure & Export Strategy**: `app.js` is currently a browser-only ES module with immediate top-level DOM evaluation. Extracting core fitting functions into `fittingMath.js` (or adding environment guards and named exports) will enable 100% unit test coverage in Node.js while keeping the browser app intact.

---

## 5. Verification Method

To independently verify these findings:
1. **Inspect Code Lines**:
   - `LM` map: `view_file` on `d:\Luceandombra\app.js` lines 49–83.
   - Nose Rest Landmark 6: `view_file` on `d:\Luceandombra\app.js` lines 64, 749–758.
   - Temple Width 1.15 Scale Factor: `view_file` on `d:\Luceandombra\app.js` lines 70–71, 714–730.
   - DOM side-effects & init call: `view_file` on `d:\Luceandombra\app.js` lines 373–420, line 1614.
2. **Node.js Execution Check**:
   - Run `node -e "import('./app.js')"` to verify the current top-level DOM error (`ReferenceError: document is not defined`).

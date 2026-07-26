# Handoff Report — Explorer 3: MediaPipe Face Landmarks Analysis & R2 Test Specifications

## 1. Observation

Direct observations from `d:\Luceandombra\app.js`:

- **MediaPipe Tasks Vision Package Import & Setup** (`d:\Luceandombra\app.js:24`, `925-944`):
  - Imported via: `import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';`
  - Instantiation in `initMediaPipe()`:
    ```javascript
    state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU',
      },
      runningMode:                        'VIDEO',
      numFaces:                           1,
      minFaceDetectionConfidence:         0.60,
      minFacePresenceConfidence:          0.60,
      minTrackingConfidence:              0.55,
      outputFaceBlendshapes:              true, // Required to extract 478 landmarks (Iris)
      outputFacialTransformationMatrixes: true,
    });
    ```

- **Landmark Reception in Render/Animation Loop** (`d:\Luceandombra\app.js:847-867`):
  ```javascript
  results = state.faceLandmarker.detectForVideo(el.webcam, nowMs);
  if (results?.faceLandmarks?.length > 0) {
    const lmArray = results.faceLandmarks[0];
    ...
    const matrix = results.facialTransformationMatrixes?.[0]?.data || null;
    onFaceResults(lmArray, matrix, nowMs);
    updateFaceDots(lmArray, true);
  }
  ```

- **Landmark Object Structure & Validation** (`d:\Luceandombra\app.js:685-694`):
  - `results.faceLandmarks` is an Array of face landmark arrays (length 1 when `numFaces: 1`).
  - `lmArray` (`results.faceLandmarks[0]`) is an Array of 468 (canonical) or 478 (with iris refinement) landmark objects.
  - Each individual landmark `lm` is an Object with schema:
    - `x` (number): Normalized horizontal coordinate in range `[0.0, 1.0]` relative to video frame width (0 = left edge, 1 = right edge of raw video).
    - `y` (number): Normalized vertical coordinate in range `[0.0, 1.0]` relative to video frame height (0 = top edge, 1 = bottom edge of raw video).
    - `z` (number): Normalized depth relative to face center / scale in MediaPipe canonical face space.
  - Validation function `lmValid(lm)`:
    ```javascript
    function lmValid(lm) {
      return lm &&
        Number.isFinite(lm.x) && Number.isFinite(lm.y) && Number.isFinite(lm.z) &&
        lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1;
    }
    ```

- **Landmark Index Map (`LM`)** (`d:\Luceandombra\app.js:49-82`):
  ```javascript
  const LM = {
    // Core eye anchors
    L_EYE_INNER:   133,   // left inner canthus
    R_EYE_INNER:   362,   // right inner canthus
    L_IRIS:        468,   // left iris center
    R_IRIS:        473,   // right iris center
    L_EYE_OUTER:    33,   // left outer canthus
    R_EYE_OUTER:   263,   // right outer canthus
    ...
    // Nose
    NOSE_BRIDGE:   168,   // glabella / nose bridge top
    NOSE_REST:       6,   // lower nose bridge (where physical glasses sit)
    NOSE_TIP:        4,   // tip of nose
    ...
    // Face contour
    L_TEMPLE:      234,   // left temple
    R_TEMPLE:      454,   // right temple
    FOREHEAD:       10,   // mid forehead
    CHIN:          152,   // chin tip
    JAW_L:         172,   // lower jaw left
    JAW_R:         397,   // lower jaw right
    CHEEK_L:       234,   // cheekbone left
    CHEEK_R:       454,   // cheekbone right
  };
  ```

- **Exact Landmark Indices Requested**:
  - **Landmark 6 (`NOSE_REST = 6`)**: Lower nose bridge anchor point.
  - **Left Temple Index**: `234` (`LM.L_TEMPLE = 234`).
  - **Right Temple Index**: `454` (`LM.R_TEMPLE = 454`).

- **Coordinate Mapping (`landmarkToWorld`)** (`d:\Luceandombra\app.js:527-550`):
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

- **3D Scale & Position Calculations (`onFaceResults`)** (`d:\Luceandombra\app.js:712-776`):
  ```javascript
  // Scale calculation:
  const lt = safeLM(lmArray, LM.L_TEMPLE); // 234
  const rt = safeLM(lmArray, LM.R_TEMPLE); // 454
  ...
  const templeW = landmarkToWorld(lt).distanceTo(landmarkToWorld(rt));
  const rawScale = templeW * 1.15;
  const filteredScale = OEF.scale.filter(rawScale, timestamp);
  target.scale.setScalar(Math.max(filteredScale, 0.01));

  // Position calculation:
  const nr = safeLM(lmArray, LM.NOSE_REST); // 6
  ...
  const anchorWorld = landmarkToWorld({ x: nr.x, y: nr.y, z: nr.z });
  const depthFactor = Math.max(0.5, Math.min(1.5, 1.0 / (filteredScale * 4 + 0.001)));
  const localOffset = new THREE.Vector3(0, 0, -filteredScale * 0.02 * depthFactor);
  localOffset.applyQuaternion(target.quat);

  const rawX = anchorWorld.x + localOffset.x;
  const rawY = anchorWorld.y + localOffset.y;
  const rawZ = anchorWorld.z + localOffset.z;

  const filteredX = OEF.x.filter(rawX, timestamp);
  const filteredY = OEF.y.filter(rawY, timestamp);
  const filteredZ = OEF.z.filter(rawZ, timestamp);

  target.position.set(filteredX, filteredY, filteredZ);
  ```

---

## 2. Logic Chain

1. **Landmark Reception & Structure**:
   - `state.faceLandmarker.detectForVideo()` returns a `FaceLandmarkerResult` object containing `faceLandmarks: Landmark[][]`.
   - `results.faceLandmarks[0]` contains an array of landmark objects `{x, y, z}`.
   - Values `x` and `y` are normalized ratios relative to video frame width and height.
   - `lmValid` ensures `x` and `y` are numbers between `0` and `1`, and `z` is finite.

2. **Mathematical Derivation of World Coordinates (`landmarkToWorld`)**:
   - Step A: Compute `scale = max(window.innerWidth / videoWidth, window.innerHeight / videoHeight)` to emulate `object-fit: cover`.
   - Step B: Rendered video size: `rvw = videoWidth * scale`, `rvh = videoHeight * scale`.
   - Step C: Center offsets: `offX = (window.innerWidth - rvw) / 2`, `offY = (window.innerHeight - rvh) / 2`.
   - Step D: Convert normalized landmark to viewport pixel space (`px`, `py`):
     - Horizontal flip for selfie display: `px = offX + (1.0 - lm.x) * rvw`.
     - Vertical top-down pixel: `py = offY + lm.y * rvh`.
   - Step E: Convert pixel coordinates to Orthographic Camera clip space (`worldX`, `worldY`):
     - Orthographic camera height is `2.0` (from `-1.0` to `+1.0`), width is `2.0 * (window.innerWidth / window.innerHeight)`.
     - `worldX = (2 * px - window.innerWidth) / window.innerHeight`.
     - `worldY = (window.innerHeight - 2 * py) / window.innerHeight`.
     - `worldZ = zOverride ?? 0.05`.

3. **3D Scale Mathematical Formula**:
   - Left Temple landmark index: `234`. Right Temple landmark index: `454`.
   - 3D distance between temples in world space:
     $$templeW = \sqrt{(x_{lt} - x_{rt})^2 + (y_{lt} - y_{rt})^2 + (z_{lt} - z_{rt})^2}$$
     (Since $z$ defaults to $0.05$ for both landmarks in `landmarkToWorld(lt)` and `landmarkToWorld(rt)`, $z_{lt} - z_{rt} = 0$).
   - Raw 3D scale with factor `1.15`:
     $$rawScale = templeW \times 1.15$$
   - The factor `1.15` scales the temple-to-temple distance by 15% to ensure the physical frame hinges extend beyond the head temples for a natural fit.
   - Filtered scale: `filteredScale = OneEuroFilter.filter(rawScale, timestamp)`.
   - Uniform 3D scale vector:
     $$scaleX = scaleY = scaleZ = \max(filteredScale, 0.01)$$

4. **3D Position Mathematical Formula**:
   - Nose Rest landmark index: `6` (`NOSE_REST`).
   - World anchor position:
     $$anchorWorld = landmarkToWorld(\{ x: lm[6].x, y: lm[6].y, z: lm[6].z \})$$
   - Depth compensation offset:
     $$depthFactor = \text{clamp}\left(\frac{1.0}{4 \cdot filteredScale + 0.001}, 0.5, 1.5\right)$$
     $$localOffset = \mathbf{R}_{head} \cdot \begin{pmatrix} 0 \\ 0 \\ -0.02 \cdot filteredScale \cdot depthFactor \end{pmatrix}$$
     where $\mathbf{R}_{head}$ is the head orientation matrix/quaternion derived from `facialTransformationMatrixes`.
   - Unfiltered world position:
     $$\mathbf{P}_{raw} = anchorWorld + localOffset$$
   - Filtered 3D position vector:
     $$x_{target} = OneEuroFilter_x.filter(P_{raw.x}, timestamp)$$
     $$y_{target} = OneEuroFilter_y.filter(P_{raw.y}, timestamp)$$
     $$z_{target} = OneEuroFilter_z.filter(P_{raw.z}, timestamp)$$

---

## 3. Caveats

- **Iris vs canthus fallback**: `onFaceResults` checks `lmArray.length >= 478` to decide whether to use iris landmarks (`468`/`473`) or inner canthus landmarks (`133`/`362`), though temple width (`234`/`454`) is the primary driver for scale.
- **Head rotation influence on local offset**: The position offset relies on `target.quat` derived from `facialTransformationMatrixes`. If `facialTransformationMatrixes` is null, `target.quat` retains its previous orientation (or identity).
- **No external code modifications**: Per Explorer role rules, all analysis is strictly read-only.

---

## 4. Conclusion

- **Landmark Reception**: MediaPipe Vision Tasks `FaceLandmarker` outputs `results.faceLandmarks[0]`, an array of 468/478 landmark objects.
- **Landmark Object Structure**: `{ x: number [0..1], y: number [0..1], z: number }`.
- **Target Indices**:
  - Nose rest: **Landmark 6** (`NOSE_REST`).
  - Left temple: **Landmark 234** (`L_TEMPLE`).
  - Right temple: **Landmark 454** (`R_TEMPLE`).
- **Scale Formula**: `scale = Math.max(OneEuroFilter(templeW * 1.15), 0.01)`.
- **Position Formula**: `position = OneEuroFilter(landmarkToWorld(LM[6]) + localOffset)`.

### Mock MediaPipe Landmark Data Strategy & R2 Assertions

#### Creating Mock Landmark Data for Unit Tests:
```javascript
/**
 * Creates a mock 478-point MediaPipe faceLandmarks array for testing.
 * @param {Object} overrides Index-keyed landmark object overrides, e.g. { 6: { x: 0.5, y: 0.4, z: -0.01 } }
 */
function createMockFaceLandmarks(overrides = {}) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0.0 }));

  // Set default realistic canonical positions
  landmarks[6]   = { x: 0.50, y: 0.45, z: -0.05 }; // NOSE_REST
  landmarks[234] = { x: 0.35, y: 0.40, z: -0.02 }; // L_TEMPLE
  landmarks[454] = { x: 0.65, y: 0.40, z: -0.02 }; // R_TEMPLE
  landmarks[133] = { x: 0.42, y: 0.42, z: -0.03 }; // L_EYE_INNER
  landmarks[362] = { x: 0.58, y: 0.42, z: -0.03 }; // R_EYE_INNER
  landmarks[10]  = { x: 0.50, y: 0.20, z: 0.00 };  // FOREHEAD
  landmarks[152] = { x: 0.50, y: 0.80, z: 0.00 };  // CHIN
  landmarks[172] = { x: 0.38, y: 0.75, z: 0.00 };  // JAW_L
  landmarks[397] = { x: 0.62, y: 0.75, z: 0.00 };  // JAW_R

  // Apply custom overrides
  Object.keys(overrides).forEach(idx => {
    const i = Number(idx);
    landmarks[i] = { ...landmarks[i], ...overrides[i] };
  });

  return landmarks;
}
```

#### R2 Test Assertions:
1. **Validation Assertion**:
   - `expect(lmValid({x: 0.5, y: 0.5, z: 0})).toBe(true)`
   - `expect(lmValid({x: 1.5, y: 0.5, z: 0})).toBe(false)`
   - `expect(lmValid({x: NaN, y: 0.5, z: 0})).toBe(false)`

2. **Coordinate Mirroring Assertion**:
   - Set viewport = 1000x1000, video = 1000x1000.
   - For `lm = {x: 0.2, y: 0.5, z: 0}`, `landmarkToWorld(lm)` must return `worldX = +0.6` (reflecting `1.0 - 0.2 = 0.8` pixel position).
   - For `lm = {x: 0.8, y: 0.5, z: 0}`, `landmarkToWorld(lm)` must return `worldX = -0.6` (reflecting `1.0 - 0.8 = 0.2` pixel position).

3. **Scale Factor 1.15 Assertion**:
   - Given `lt` (index 234) and `rt` (index 454), measure `templeW = landmarkToWorld(lt).distanceTo(landmarkToWorld(rt))`.
   - Assert `rawScale === templeW * 1.15`.
   - Assert `target.scale.x === target.scale.y === target.scale.z === Math.max(filteredScale, 0.01)`.

4. **Nose Rest Position Tracking Assertion**:
   - Verify `onFaceResults` updates `target.position` to match `landmarkToWorld(lmArray[6])` adjusted by `localOffset` and filtered by `OEF.x`, `OEF.y`, `OEF.z`.

---

## 5. Verification Method

To independently verify these findings:

1. **Inspect Source Code**:
   - Open `d:\Luceandombra\app.js`.
   - Check lines 49-82 for landmark index mappings (`LM.NOSE_REST = 6`, `LM.L_TEMPLE = 234`, `LM.R_TEMPLE = 454`).
   - Check lines 527-550 for `landmarkToWorld` transformation logic.
   - Check lines 712-776 for `onFaceResults` scale (`1.15` multiplier) and position calculation logic.
   - Check lines 847-867 for `detectForVideo` call and `results.faceLandmarks[0]` extraction.

2. **Automated / Console Verification**:
   - In a browser console running `app.js`, evaluate:
     - `LM.NOSE_REST === 6`
     - `LM.L_TEMPLE === 234`
     - `LM.R_TEMPLE === 454`

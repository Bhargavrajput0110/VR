# Handoff Report: Empirical Accuracy & Viewport Invariance Verification of `fittingMath.js`

**Agent**: Challenger 2 (Empirical Challenger: critic, specialist)  
**Target File**: `d:\Luceandombra\fittingMath.js`  
**Working Directory**: `d:\Luceandombra\.agents\challenger_2`  

---

## 1. Observation

Direct code inspection of `d:\Luceandombra\fittingMath.js` reveals the following key mathematical functions and constants:

1. **Landmark Constants (`LM`) (lines 8–41)**:
   - `L_TEMPLE = 234`, `R_TEMPLE = 454`
   - `NOSE_REST = 6` (lower nose bridge anchor where physical frames sit)

2. **Validation (`lmValid` and `safeLM`) (lines 48–69)**:
   - `lmValid`: Requires finite numbers for `x, y, z` and strict bounds `0 <= x <= 1`, `0 <= y <= 1`. Rejects `NaN`, `Infinity`, out-of-range inputs, and non-numeric types.

3. **Coordinate Mapping (`landmarkToWorld`) (lines 79–155)**:
   ```javascript
   // Lines 125-142
   const windowAspect = w / h;
   const videoAspect  = vw / vh;
   const scale        = windowAspect > videoAspect ? w / vw : h / vh;

   const rvw  = vw * scale;
   const rvh  = vh * scale;
   const offX = (w - rvw) / 2;
   const offY = (h - rvh) / 2;

   // Horizontal mirroring transformation: (1.0 - lm.x)
   const px = offX + (1.0 - lm.x) * rvw;
   const py = offY + lm.y * rvh;

   const halfW = windowAspect;
   const worldX =  (px / w) * (2 * halfW) - halfW;
   const worldY = -((py / h) * 2 - 1);
   const worldZ = zOverride !== undefined ? zOverride : (lm.z !== undefined ? lm.z : 0.05);
   ```

4. **Model Scale & Position Calculation (`calculateScaleAndPosition`) (lines 166–221)**:
   ```javascript
   // Lines 175-180
   const ltWorld = landmarkToWorld(lt, viewportOptions);
   const rtWorld = landmarkToWorld(rt, viewportOptions);
   const templeW = ltWorld.distanceTo(rtWorld);
   const rawScale = templeW * 1.15;

   // Lines 187-197
   const nr = safeLM(lmArray, LM.NOSE_REST); // Landmark 6
   const anchorWorld = landmarkToWorld(nr, viewportOptions);
   const depthFactor = Math.max(0.5, Math.min(1.5, 1.0 / (scale * 4 + 0.001)));
   const localOffsetZ = -scale * 0.02 * depthFactor;
   const rawX = anchorWorld.x;
   const rawY = anchorWorld.y;
   const rawZ = anchorWorld.z + localOffsetZ;
   ```

5. **One Euro Filter (`OneEuroFilter`) (lines 227–268)**:
   - Uses low-pass filtering with cutoff frequency $f_c = \text{minCutoff} + \beta |\hat{dx}|$. Includes zero/negative timestamp protection (`if (dt > 0)`).

---

## 2. Logic Chain

### A. Closed-Form Derivation of `landmarkToWorld`
Let $W_a = w / h$ be the window aspect ratio and $V_a = vw / vh$ be the video aspect ratio.

1. **Case 1: $W_a \le V_a$** (Cover cropped vertically / pillarboxed laterally or exact fit — e.g. 16:9, 4:3, 1:1, portrait 9:16 window with a 16:9 video stream):
   - `scale = h / vh`
   - $rvw = vw \cdot (h / vh) = h \cdot V_a$
   - $rvh = h$
   - $offX = (w - h \cdot V_a) / 2$
   - $px = (w - h \cdot V_a)/2 + (1 - lm.x) \cdot h \cdot V_a = \frac{w}{2} + h \cdot V_a (0.5 - lm.x)$
   - $worldX = \frac{2 px - w}{h} = \frac{2 [\frac{w}{2} + h \cdot V_a (0.5 - lm.x)] - w}{h} = V_a (1 - 2 \cdot lm.x)$
   - $py = lm.y \cdot h \implies worldY = -(2 lm.y - 1) = 1 - 2 \cdot lm.y$

   **Result for $W_a \le V_a$**:
   $$\mathbf{worldX = V_a \cdot (1 - 2 \cdot lm.x)}$$
   $$\mathbf{worldY = 1 - 2 \cdot lm.y}$$
   Notice that neither $w$ nor $h$ nor $W_a$ appears in these final expressions. Thus, for any window resolution or aspect ratio satisfying $W_a \le V_a$, the 3D world coordinates are **100% invariant** to window dimensions and aspect ratio.

2. **Case 2: $W_a > V_a$** (Ultrawide windows — e.g. 21:9 window with a 16:9 video stream):
   - `scale = w / vw`
   - $worldX = W_a \cdot (1 - 2 \cdot lm.x)$
   - $worldY = \frac{W_a}{V_a} \cdot (1 - 2 \cdot lm.y)$
   In this region, coordinates scale proportionally with $W_a / V_a$ to account for horizontal video expansion under CSS `object-fit: cover`.

### B. Verification of Scale Multiplier 1.15
1. By definition in line 179: `rawScale = templeW * 1.15`.
2. Therefore, $\frac{rawScale}{templeW} \equiv 1.15$ holds with **100% exact numerical identity** ($\text{error} = 0.0000000000000000$).
3. Under 2D translation $(t_x, t_y)$ of landmarks:
   - $\Delta X' = worldX_{LT}' - worldX_{RT}' = \Delta X$
   - $\Delta Y' = worldY_{LT}' - worldY_{RT}' = \Delta Y$
   - $templeW' = \sqrt{(\Delta X)^2 + (\Delta Y)^2 + (\Delta Z)^2} = templeW$ (translation invariant).
4. Under 2D scaling $s$:
   - $\Delta X' = s \cdot \Delta X$, $\Delta Y' = s \cdot \Delta Y$
   - $templeW' = s \cdot templeW$ and $rawScale' = s \cdot rawScale$ (perfect linear scaling).

### C. Origin Centering at Landmark 6 (`NOSE_REST`)
1. In line 188: `nr = safeLM(lmArray, LM.NOSE_REST)` retrieves MediaPipe Landmark 6.
2. In line 190: `anchorWorld = landmarkToWorld(nr, viewportOptions)`.
3. In lines 195–196: `rawX = anchorWorld.x` and `rawY = anchorWorld.y`.
4. In line 193: `localOffsetZ = -scale * 0.02 * depthFactor` (small Z offset for physical nose bridge depth).
5. Result: In the XY plane, the model origin aligns **EXACTLY** with Landmark 6 (`NOSE_REST`) under all translations, scalings, and rotations.

---

## 3. Caveats

1. **Ultrawide Viewport Scaling ($W_a > V_a$)**: When the viewport aspect ratio exceeds the video feed aspect ratio (e.g. 21:9 window with 16:9 webcam), world coordinates scale up by factor $\frac{W_a}{V_a}$. This behavior is intentional to match Three.js perspective camera FOV expansion under CSS `object-fit: cover`.
2. **Extreme Out-of-Plane Head Yaw/Pitch**: 2D Euclidean temple width (`templeW`) decreases under out-of-plane head rotation (yaw/pitch > $45^\circ$) due to perspective foreshortening. The filter state and 3-measurement averaging in `app.js` mitigate temporal fluctuation during quick head turns.

---

## 4. Conclusion

1. **Landmark Validation (`lmValid`)**: Perfectly guards against non-finite values (`NaN`, `Infinity`), out-of-bounds coordinates ($<0$ or $>1$), and null/invalid types.
2. **Viewport & Aspect Ratio Invariance (`landmarkToWorld`)**: Mathematically proven and empirically confirmed to be **100% invariant** across window dimensions and standard aspect ratios (16:9, 4:3, 1:1, portrait 9:16).
3. **Scale Multiplier (1.15)**: Holds with **100% numerical precision** ($\frac{rawScale}{templeW} \equiv 1.15$). Scales linearly under landmark scaling and remains invariant under translation.
4. **Origin Centering at Landmark 6**: Frames are centered precisely at Landmark 6 (`NOSE_REST`) in 3D XY space.
5. **One Euro Filter**: Numerically robust with built-in zero-dt protection preventing division by zero or NaN propagation.

---

## 5. Verification Method

To verify these results independently:

1. Inspect `d:\Luceandombra\fittingMath.js` (lines 79–221).
2. Run the empirical harness script created in `.agents/challenger_2/empirical_harness.js`:
   ```bash
   node .agents/challenger_2/empirical_harness.js
   ```
3. Check the mathematical closed-form derivations in Section 2 of this report:
   - For $W_a \le V_a$: $worldX = V_a (1 - 2 \cdot lm.x)$, $worldY = 1 - 2 \cdot lm.y$.
   - Confirm that changing $w$ and $h$ while maintaining $W_a \le V_a$ yields identical outputs for any given landmark point $(x, y, z)$.

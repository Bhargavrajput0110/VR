/**
 * Empirical Verification Harness for fittingMath.js
 * Challenger 2 - Luceandombra
 */

import {
  LM,
  lmValid,
  safeLM,
  landmarkToWorld,
  calculateScaleAndPosition,
  OneEuroFilter
} from '../../fittingMath.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

const results = {
  lmValidSuite: [],
  viewportScaleSuite: [],
  aspectRatioSuite: [],
  scaleMultiplierSuite: [],
  originCenteringSuite: [],
  transformationInvarianceSuite: [],
  oneEuroFilterSuite: []
};

function assert(condition, message, detail = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`[PASS] ${message}`);
    return true;
  } else {
    failedTests++;
    console.error(`[FAIL] ${message} - ${detail}`);
    return false;
  }
}

function approxEqual(a, b, epsilon = 1e-7) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (isNaN(a) && isNaN(b)) return true;
  return Math.abs(a - b) <= epsilon;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LANDMARK VALIDATION & BOUNDARY TESTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== SUITE 1: Landmark Validation & Boundary Tests ===');

// Valid cases
assert(lmValid({ x: 0.5, y: 0.5, z: 0.0 }), 'lmValid accepts (0.5, 0.5, 0.0)');
assert(lmValid({ x: 0.0, y: 0.0, z: -1.0 }), 'lmValid accepts boundary (0.0, 0.0, -1.0)');
assert(lmValid({ x: 1.0, y: 1.0, z: 100.0 }), 'lmValid accepts boundary (1.0, 1.0, 100.0)');

// Out of range / invalid cases
assert(!lmValid({ x: -0.001, y: 0.5, z: 0 }), 'lmValid rejects x < 0 (-0.001)');
assert(!lmValid({ x: 1.001, y: 0.5, z: 0 }), 'lmValid rejects x > 1 (1.001)');
assert(!lmValid({ x: 0.5, y: -0.001, z: 0 }), 'lmValid rejects y < 0 (-0.001)');
assert(!lmValid({ x: 0.5, y: 1.001, z: 0 }), 'lmValid rejects y > 1 (1.001)');
assert(!lmValid({ x: NaN, y: 0.5, z: 0 }), 'lmValid rejects x = NaN');
assert(!lmValid({ x: 0.5, y: Infinity, z: 0 }), 'lmValid rejects y = Infinity');
assert(!lmValid({ x: 0.5, y: 0.5, z: NaN }), 'lmValid rejects z = NaN');
assert(!lmValid({ x: 0.5, y: 0.5, z: Infinity }), 'lmValid rejects z = Infinity');
assert(!lmValid(null), 'lmValid rejects null');
assert(!lmValid(undefined), 'lmValid rejects undefined');
assert(!lmValid({ x: '0.5', y: 0.5, z: 0 }), 'lmValid rejects string x');

// safeLM tests
const mockLMArray = new Array(500).fill(null);
mockLMArray[LM.L_TEMPLE] = { x: 0.3, y: 0.4, z: 0.01 };
mockLMArray[LM.R_TEMPLE] = { x: 0.7, y: 0.4, z: 0.01 };
mockLMArray[LM.NOSE_REST] = { x: 0.5, y: 0.5, z: 0.02 };
mockLMArray[LM.L_EYE_INNER] = { x: 0.4, y: 0.42, z: 0.01 };
mockLMArray[LM.R_EYE_INNER] = { x: 0.6, y: 0.42, z: 0.01 };

assert(safeLM(mockLMArray, LM.L_TEMPLE) !== null, 'safeLM returns valid object');
assert(safeLM(mockLMArray, 999) === null, 'safeLM returns null for out of bound index');
assert(safeLM(mockLMArray, -1) === null, 'safeLM returns null for negative index');
assert(safeLM(null, 10) === null, 'safeLM returns null for null array');

// ─────────────────────────────────────────────────────────────────────────────
// 2. VIEWPORT DIMENSION & ASPECT RATIO INVARIANCE SUITE
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== SUITE 2: Viewport Dimensions & Aspect Ratio Invariance ===');

const testLandmark = { x: 0.4, y: 0.45, z: 0.03 };

// Test 2A: Viewport Scaling at Constant Aspect Ratio (16:9)
console.log('--- Test 2A: Viewport Scaling at Fixed 16:9 Aspect Ratio ---');
const dimensions16_9 = [
  { width: 3840, height: 2160, videoWidth: 1280, videoHeight: 720 },
  { width: 1920, height: 1080, videoWidth: 1280, videoHeight: 720 },
  { width: 1280, height: 720,  videoWidth: 1280, videoHeight: 720 },
  { width: 640,  height: 360,  videoWidth: 1280, videoHeight: 720 },
  { width: 320,  height: 180,  videoWidth: 1280, videoHeight: 720 },
];

const baseWorld16_9 = landmarkToWorld(testLandmark, dimensions16_9[1]); // 1920x1080
let scalingInvariant = true;
dimensions16_9.forEach(dim => {
  const w = landmarkToWorld(testLandmark, dim);
  const diffX = Math.abs(w.x - baseWorld16_9.x);
  const diffY = Math.abs(w.y - baseWorld16_9.y);
  const diffZ = Math.abs(w.z - baseWorld16_9.z);
  if (diffX > 1e-12 || diffY > 1e-12 || diffZ > 1e-12) {
    scalingInvariant = false;
    console.error(`Dimension mismatch at ${dim.width}x${dim.height}: diffX=${diffX}, diffY=${diffY}`);
  }
});
assert(scalingInvariant, 'landmarkToWorld is 100% invariant to viewport dimension scaling at fixed 16:9 aspect ratio');

// Test 2B: Aspect Ratio Matrix Analysis
console.log('--- Test 2B: Aspect Ratio Matrix Analysis ---');
const aspectRatios = [
  { name: '16:9 Landscape',  width: 1920, height: 1080, videoWidth: 1280, videoHeight: 720 },
  { name: '4:3 Standard',    width: 1440, height: 1080, videoWidth: 1280, videoHeight: 720 },
  { name: '1:1 Square',      width: 1080, height: 1080, videoWidth: 1280, videoHeight: 720 },
  { name: '9:16 Portrait',   width: 607.5, height: 1080, videoWidth: 1280, videoHeight: 720 },
  { name: '21:9 Ultrawide',  width: 2520, height: 1080, videoWidth: 1280, videoHeight: 720 },
];

console.log('Landmark (0.4, 0.45, 0.03) mapped across viewport aspect ratios:');
const aspectResults = aspectRatios.map(ar => {
  const res = landmarkToWorld(testLandmark, ar);
  const calcScaleAndPos = calculateScaleAndPosition(mockLMArray, ar);
  return {
    name: ar.name,
    aspectRatio: (ar.width / ar.height).toFixed(4),
    worldX: res.x.toFixed(6),
    worldY: res.y.toFixed(6),
    worldZ: res.z.toFixed(6),
    calcScale: calcScaleAndPos ? calcScaleAndPos.scale.toFixed(6) : 'null',
    templeW: calcScaleAndPos ? calcScaleAndPos.templeW.toFixed(6) : 'null',
    anchorX: calcScaleAndPos ? calcScaleAndPos.anchorWorld.x.toFixed(6) : 'null',
    anchorY: calcScaleAndPos ? calcScaleAndPos.anchorWorld.y.toFixed(6) : 'null',
  };
});
console.table(aspectResults);

// Check if scale and world distances change across aspect ratios where windowAspect <= videoAspect vs > videoAspect
const res169 = landmarkToWorld(testLandmark, aspectRatios[0]); // 16:9 (aspect 1.7778)
const res43  = landmarkToWorld(testLandmark, aspectRatios[1]); // 4:3 (aspect 1.3333)
const res11  = landmarkToWorld(testLandmark, aspectRatios[2]); // 1:1 (aspect 1.0)
const res916 = landmarkToWorld(testLandmark, aspectRatios[3]); // 9:16 (aspect 0.5625)
const res219 = landmarkToWorld(testLandmark, aspectRatios[4]); // 21:9 (aspect 2.3333)

// Notice videoAspect = 1280/720 = 1.7777777777777777
// When windowAspect <= videoAspect (16:9, 4:3, 1:1, 9:16), windowAspect <= 1.7777777777777777.
// Let's verify whether (worldX, worldY) remain invariant across all windowAspect <= videoAspect!
const invariantUnderCoverCrop = (
  approxEqual(res169.x, res43.x, 1e-7) && approxEqual(res169.y, res43.y, 1e-7) &&
  approxEqual(res169.x, res11.x, 1e-7) && approxEqual(res169.y, res11.y, 1e-7) &&
  approxEqual(res169.x, res916.x, 1e-7) && approxEqual(res169.y, res916.y, 1e-7)
);

assert(invariantUnderCoverCrop, 'landmarkToWorld is invariant across 16:9, 4:3, 1:1, 9:16 when windowAspect <= videoAspect');

// Check ultrawide 21:9 where windowAspect (2.333) > videoAspect (1.777)
const isUltrawideDifferent = !approxEqual(res219.x, res169.x, 1e-4) || !approxEqual(res219.y, res169.y, 1e-4);
console.log(`Ultrawide (21:9) behavior: worldX=${res219.x}, worldY=${res219.y} vs 16:9 worldX=${res169.x}, worldY=${res169.y}`);
assert(isUltrawideDifferent, 'Ultrawide (21:9) scales world coordinates when windowAspect > videoAspect due to horizontal cover scaling');

// ─────────────────────────────────────────────────────────────────────────────
// 3. SCALE MULTIPLIER 1.15 & LANDMARK 6 ORIGIN CENTERING INVARIANCE
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== SUITE 3: Scale Multiplier 1.15 & Landmark 6 Centering ===');

// Helper to create transformed landmark array
function transformLandmarks(baseLM, { tx = 0, ty = 0, scale = 1.0, rotationRad = 0, center = { x: 0.5, y: 0.5 } }) {
  return baseLM.map(lm => {
    if (!lm) return null;
    // 1. Shift to center
    let cx = lm.x - center.x;
    let cy = lm.y - center.y;
    // 2. Scale
    cx *= scale;
    cy *= scale;
    // 3. Rotate
    const rx = cx * Math.cos(rotationRad) - cy * Math.sin(rotationRad);
    const ry = cx * Math.sin(rotationRad) + cy * Math.cos(rotationRad);
    // 4. Translate and shift back
    return {
      x: rx + center.x + tx,
      y: ry + center.y + ty,
      z: lm.z !== undefined ? lm.z : 0.01
    };
  });
}

const viewportDefault = { width: 1920, height: 1080, videoWidth: 1280, videoHeight: 720 };
const baseFit = calculateScaleAndPosition(mockLMArray, viewportDefault);

assert(baseFit !== null, 'calculateScaleAndPosition returns non-null result for valid face landmarks');
const expectedRawScale = baseFit.templeW * 1.15;
assert(approxEqual(baseFit.scale, expectedRawScale, 1e-12), `Scale exactly equals templeW * 1.15 (scale=${baseFit.scale}, templeW*1.15=${expectedRawScale})`);

// Test 3A: Translation Invariance of Scale & Precision of Landmark 6 Centering
console.log('--- Test 3A: Translation Invariance & Centering ---');
const translations = [
  { tx: 0.05, ty: 0.05 },
  { tx: -0.1, ty: 0.02 },
  { tx: 0.15, ty: -0.1 },
];

translations.forEach(t => {
  const transLM = transformLandmarks(mockLMArray, t);
  const fit = calculateScaleAndPosition(transLM, viewportDefault);
  const nrLM = transLM[LM.NOSE_REST]; // Landmark 6
  const nrWorld = landmarkToWorld(nrLM, viewportDefault);

  assert(approxEqual(fit.templeW, baseFit.templeW, 1e-7), `templeW invariant under translation (${t.tx}, ${t.ty})`);
  assert(approxEqual(fit.scale, baseFit.scale, 1e-7), `scale invariant under translation (${t.tx}, ${t.ty})`);
  assert(approxEqual(fit.scale / fit.templeW, 1.15, 1e-12), `scale / templeW == 1.15 under translation`);
  assert(approxEqual(fit.position.x, nrWorld.x, 1e-12), `Origin X anchored to Landmark 6 X`);
  assert(approxEqual(fit.position.y, nrWorld.y, 1e-12), `Origin Y anchored to Landmark 6 Y`);
});

// Test 3B: Scale Proportionality
console.log('--- Test 3B: Scaling Proportionality ---');
const scaleFactors = [0.5, 0.8, 1.25, 1.5, 2.0];
scaleFactors.forEach(s => {
  const scaledLM = transformLandmarks(mockLMArray, { scale: s });
  const fit = calculateScaleAndPosition(scaledLM, viewportDefault);

  assert(approxEqual(fit.templeW, baseFit.templeW * s, 1e-7), `templeW scales proportionally by factor ${s}`);
  assert(approxEqual(fit.scale, baseFit.scale * s, 1e-7), `Model scale scales proportionally by factor ${s}`);
  assert(approxEqual(fit.scale / fit.templeW, 1.15, 1e-12), `scale / templeW remains exactly 1.15 when scaled by ${s}`);
});

// Test 3C: 2D Rotation Invariance
console.log('--- Test 3C: 2D Rotation Invariance ---');
const angles = [Math.PI / 12, Math.PI / 6, Math.PI / 4, -Math.PI / 6]; // 15°, 30°, 45°, -30°
angles.forEach(deg => {
  const rotatedLM = transformLandmarks(mockLMArray, { rotationRad: deg });
  const fit = calculateScaleAndPosition(rotatedLM, viewportDefault);
  const nrLM = rotatedLM[LM.NOSE_REST];
  const nrWorld = landmarkToWorld(nrLM, viewportDefault);

  assert(approxEqual(fit.templeW, baseFit.templeW, 1e-7), `templeW invariant under 2D rotation of ${(deg*180/Math.PI).toFixed(0)}°`);
  assert(approxEqual(fit.scale / fit.templeW, 1.15, 1e-12), `scale / templeW == 1.15 under 2D rotation of ${(deg*180/Math.PI).toFixed(0)}°`);
  assert(approxEqual(fit.position.x, nrWorld.x, 1e-12), `Origin X centered at Landmark 6 under ${(deg*180/Math.PI).toFixed(0)}° rotation`);
  assert(approxEqual(fit.position.y, nrWorld.y, 1e-12), `Origin Y centered at Landmark 6 under ${(deg*180/Math.PI).toFixed(0)}° rotation`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FILTERING & ONE EURO FILTER NUMERICAL STABILITY SUITE
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== SUITE 4: One Euro Filter Numerical Stability ===');

const filter = new OneEuroFilter(30, 1.0, 0.007, 1.0);
const firstVal = filter.filter(10.0, 0);
assert(firstVal === 10.0, 'OneEuroFilter initializes to first input value');

const secondVal = filter.filter(10.5, 33.33); // ~30 FPS step
assert(typeof secondVal === 'number' && Number.isFinite(secondVal), 'OneEuroFilter step yields finite number');
assert(secondVal > 10.0 && secondVal < 10.5, 'OneEuroFilter smoothly interpolates value');

// Test zero/negative dt protection
const sameTimeVal = filter.filter(12.0, 33.33); // dt = 0
assert(Number.isFinite(sameTimeVal), 'OneEuroFilter handles dt = 0 gracefully without NaN');

filter.reset();
assert(filter._x === null, 'OneEuroFilter reset clears internal state');

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n==================================================');
console.log(`TOTAL TESTS: ${totalTests}`);
console.log(`PASSED:      ${passedTests}`);
console.log(`FAILED:      ${failedTests}`);
console.log('==================================================');

if (failedTests > 0) {
  process.exit(1);
}

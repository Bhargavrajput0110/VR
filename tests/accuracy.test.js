import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LM,
  lmValid,
  safeLM,
  landmarkToWorld,
  calculateScaleAndPosition,
  OneEuroFilter
} from '../fittingMath.js';

/**
 * Helper to generate a 478-point MediaPipe face landmark array with optional overrides.
 * @param {Object} overrides - Keyed by index or LM constant name.
 * @returns {Array} 478 landmark objects { x, y, z }
 */
export function createMockFaceLandmarks(overrides = {}) {
  const lmArray = new Array(478);
  
  // Default values
  for (let i = 0; i < 478; i++) {
    lmArray[i] = { x: 0.5, y: 0.5, z: 0.0 };
  }

  // Realistic defaults for key fitting landmarks
  lmArray[LM.L_TEMPLE]    = { x: 0.3, y: 0.5, z: 0.0 }; // 234
  lmArray[LM.R_TEMPLE]    = { x: 0.7, y: 0.5, z: 0.0 }; // 454
  lmArray[LM.NOSE_REST]   = { x: 0.5, y: 0.45, z: 0.0 }; // 6
  lmArray[LM.L_EYE_INNER] = { x: 0.4, y: 0.45, z: 0.0 }; // 133
  lmArray[LM.R_EYE_INNER] = { x: 0.6, y: 0.45, z: 0.0 }; // 362
  lmArray[LM.L_IRIS]      = { x: 0.4, y: 0.45, z: 0.0 }; // 468
  lmArray[LM.R_IRIS]      = { x: 0.6, y: 0.45, z: 0.0 }; // 473

  // Apply overrides
  for (const [key, val] of Object.entries(overrides)) {
    const idx = Number.isInteger(Number(key)) ? Number(key) : LM[key];
    if (idx !== undefined && idx >= 0 && idx < 478) {
      lmArray[idx] = { ...lmArray[idx], ...val };
    }
  }

  return lmArray;
}

test('LM constants validation', () => {
  assert.strictEqual(LM.NOSE_REST, 6, 'NOSE_REST landmark must be index 6');
  assert.strictEqual(LM.L_TEMPLE, 234, 'L_TEMPLE landmark must be index 234');
  assert.strictEqual(LM.R_TEMPLE, 454, 'R_TEMPLE landmark must be index 454');
});

test('lmValid boundary checks', () => {
  // Valid landmarks
  assert.strictEqual(lmValid({ x: 0.5, y: 0.5, z: 0.0 }), true);
  assert.strictEqual(lmValid({ x: 0.0, y: 0.0, z: -0.5 }), true, 'Lower boundary [0,0] should be valid');
  assert.strictEqual(lmValid({ x: 1.0, y: 1.0, z: 0.5 }), true, 'Upper boundary [1,1] should be valid');

  // Out of boundary (x)
  assert.strictEqual(lmValid({ x: -0.01, y: 0.5, z: 0 }), false, 'x < 0 should be invalid');
  assert.strictEqual(lmValid({ x: 1.01, y: 0.5, z: 0 }), false, 'x > 1 should be invalid');

  // Out of boundary (y)
  assert.strictEqual(lmValid({ x: 0.5, y: -0.01, z: 0 }), false, 'y < 0 should be invalid');
  assert.strictEqual(lmValid({ x: 0.5, y: 1.01, z: 0 }), false, 'y > 1 should be invalid');

  // Non-finite z or missing coordinates
  assert.strictEqual(lmValid({ x: 0.5, y: 0.5, z: NaN }), false, 'NaN z should be invalid');
  assert.strictEqual(lmValid({ x: 0.5, y: 0.5, z: Infinity }), false, 'Infinity z should be invalid');
  assert.strictEqual(lmValid(null), false, 'null should be invalid');
  assert.strictEqual(lmValid(undefined), false, 'undefined should be invalid');
  assert.strictEqual(lmValid({}), false, 'empty object should be invalid');
});

test('safeLM landmark extraction', () => {
  const lmArray = createMockFaceLandmarks();
  
  assert.ok(safeLM(lmArray, LM.NOSE_REST) !== null);
  assert.strictEqual(safeLM(lmArray, -1), null);
  assert.strictEqual(safeLM(lmArray, 999), null);
  assert.strictEqual(safeLM(null, 6), null);
});

test('landmarkToWorld horizontal mirroring transformation (1.0 - lm.x)', () => {
  const viewport = { width: 1000, height: 1000, videoWidth: 1000, videoHeight: 1000 };

  const lmLeft  = { x: 0.2, y: 0.5, z: 0.0 };
  const lmRight = { x: 0.8, y: 0.5, z: 0.0 };

  const worldLeft  = landmarkToWorld(lmLeft, viewport);
  const worldRight = landmarkToWorld(lmRight, viewport);

  // Since x=0.2 mirrored via (1.0 - 0.2) = 0.8, and x=0.8 mirrored via (1.0 - 0.8) = 0.2,
  // worldLeft.x and worldRight.x must be symmetric opposites
  assert.strictEqual(worldLeft.x > 0, true, 'lm.x=0.2 (screen left) mirrors to positive world X (camera mirror right)');
  assert.strictEqual(worldRight.x < 0, true, 'lm.x=0.8 (screen right) mirrors to negative world X');
  assert.ok(Math.abs(worldLeft.x + worldRight.x) < 1e-6, 'Symmetric landmark x positions should result in mirrored world X');

  // Verify zOverride
  const worldWithZ = landmarkToWorld(lmLeft, viewport, 0.123);
  assert.strictEqual(worldWithZ.z, 0.123);
});

test('R2 Requirement 1: 3D model scale matches templeW * 1.15', () => {
  const viewportOptions = { width: 1280, height: 720, videoWidth: 1280, videoHeight: 720 };
  const lmArray = createMockFaceLandmarks();

  const ltWorld = landmarkToWorld(lmArray[LM.L_TEMPLE], viewportOptions);
  const rtWorld = landmarkToWorld(lmArray[LM.R_TEMPLE], viewportOptions);
  const expectedTempleW = ltWorld.distanceTo(rtWorld);
  const expectedScale = expectedTempleW * 1.15;

  const result = calculateScaleAndPosition(lmArray, viewportOptions);

  assert.ok(result !== null, 'calculateScaleAndPosition should return valid result');
  assert.ok(Math.abs(result.templeW - expectedTempleW) < 1e-6, `templeW (${result.templeW}) should match expected (${expectedTempleW})`);
  assert.ok(Math.abs(result.scale - expectedScale) < 1e-6, `Scale (${result.scale}) must match templeW * 1.15 (${expectedScale})`);
});

test('R2 Requirement 2: 3D model position origin matches Landmark 6 (NOSE_REST)', () => {
  const viewportOptions = { width: 1920, height: 1080, videoWidth: 1920, videoHeight: 1080 };
  
  // Custom landmark position for NOSE_REST
  const lmArray = createMockFaceLandmarks({
    [LM.NOSE_REST]: { x: 0.48, y: 0.42, z: -0.05 }
  });

  const expectedAnchor = landmarkToWorld(lmArray[LM.NOSE_REST], viewportOptions);
  const result = calculateScaleAndPosition(lmArray, viewportOptions);

  assert.ok(result !== null, 'calculateScaleAndPosition should return valid result');
  assert.strictEqual(result.anchorWorld.x, expectedAnchor.x, 'Anchor world X must match Landmark 6 world X');
  assert.strictEqual(result.anchorWorld.y, expectedAnchor.y, 'Anchor world Y must match Landmark 6 world Y');
  assert.strictEqual(result.anchorWorld.z, expectedAnchor.z, 'Anchor world Z must match Landmark 6 world Z');
  assert.strictEqual(result.position.x, expectedAnchor.x, '3D model position origin X must match Landmark 6');
  assert.strictEqual(result.position.y, expectedAnchor.y, '3D model position origin Y must match Landmark 6');
});

test('OneEuroFilter noise reduction & filter functionality', () => {
  const filter = new OneEuroFilter(30, 1.0, 0.007, 1.0);
  
  const v1 = filter.filter(10.0, 0);
  assert.strictEqual(v1, 10.0, 'First sample should return raw value');

  const v2 = filter.filter(12.0, 33);
  assert.ok(v2 > 10.0 && v2 < 12.0, 'Filter should smooth step jump');

  filter.reset();
  assert.strictEqual(filter._x, null, 'Reset should clear internal state');
});

test('landmarkToWorld handles null viewportOptions gracefully', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  assert.doesNotThrow(() => {
    const res = landmarkToWorld(lm, null);
    assert.ok(res !== null && typeof res.x === 'number', 'landmarkToWorld(lm, null) should return valid world position object');
  }, 'landmarkToWorld with null viewportOptions should not throw TypeError');

  const lmArray = createMockFaceLandmarks();
  assert.doesNotThrow(() => {
    const res = calculateScaleAndPosition(lmArray, null);
    assert.ok(res !== null, 'calculateScaleAndPosition with null viewportOptions should return valid result');
  }, 'calculateScaleAndPosition with null viewportOptions should not throw TypeError');
});

test('calculateScaleAndPosition sanitizes non-finite filter callback outputs (NaN / Infinity)', () => {
  const lmArray = createMockFaceLandmarks();
  const baseResult = calculateScaleAndPosition(lmArray);

  // Test scaleFilter returning NaN and Infinity
  const nanScaleFilterState = {
    scaleFilter: { filter: () => NaN },
    posFilters: {}
  };
  const nanScaleResult = calculateScaleAndPosition(lmArray, {}, nanScaleFilterState);
  assert.ok(Math.abs(nanScaleResult.scale - baseResult.scale) < 1e-6, 'Scale should fall back to rawScale when filter returns NaN');

  const infScaleFilterState = {
    scaleFilter: { filter: () => Infinity },
    posFilters: {}
  };
  const infScaleResult = calculateScaleAndPosition(lmArray, {}, infScaleFilterState);
  assert.ok(Math.abs(infScaleResult.scale - baseResult.scale) < 1e-6, 'Scale should fall back to rawScale when filter returns Infinity');

  // Test posFilters returning NaN / Infinity / -Infinity
  const nanPosFilterState = {
    scaleFilter: null,
    posFilters: {
      x: { filter: () => NaN },
      y: { filter: () => Infinity },
      z: { filter: () => -Infinity }
    }
  };
  const nanPosResult = calculateScaleAndPosition(lmArray, {}, nanPosFilterState);
  assert.strictEqual(nanPosResult.position.x, baseResult.position.x, 'Position X should fall back to rawX when filter returns NaN');
  assert.strictEqual(nanPosResult.position.y, baseResult.position.y, 'Position Y should fall back to rawY when filter returns Infinity');
  assert.strictEqual(nanPosResult.position.z, baseResult.position.z, 'Position Z should fall back to rawZ when filter returns -Infinity');
});

